#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ReleaseCommandRunner = (args: string[], cwd: string) => Promise<{ code: number | null; stdout: string; stderr: string }>;

const runGh: ReleaseCommandRunner = (args, cwd) => new Promise(resolvePromise => {
    // gh inherits GH_TOKEN itself. Never read or print credentials or command output.
    execFile('gh', args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        resolvePromise({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr });
    });
});

type Release = { id: number; tag_name: string; draft: boolean };
const releaseQuery = 'query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId tagName isDraft}}}';

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function object(text: string): Record<string, unknown> {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error('GitHub returned invalid JSON'); }
    if (!isObject(value)) throw new Error('GitHub returned an invalid object');
    return value;
}

export async function publishRelease(
    env: Partial<Pick<NodeJS.ProcessEnv, 'GITHUB_REPOSITORY' | 'RELEASE_TAG' | 'RELEASE_SHA' | 'RELEASE_VERSION'>> = process.env,
    { cwd = process.cwd(), run = runGh }: { cwd?: string; run?: ReleaseCommandRunner } = {},
): Promise<'published' | 'already-published'> {
    const repo = env.GITHUB_REPOSITORY ?? '', tag = env.RELEASE_TAG ?? '', sha = env.RELEASE_SHA ?? '';
    const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
    if (!match || match[0] !== tag || !match.slice(1).every(part => Number.isSafeInteger(Number(part)))) throw new Error('RELEASE_TAG must be canonical vX.Y.Z with safe numeric components');
    const version = tag.slice(1);
    if (env.RELEASE_VERSION !== undefined && env.RELEASE_VERSION !== version) throw new Error('RELEASE_VERSION does not match RELEASE_TAG');
    if (sha.length !== 40 || !/^[a-fA-F0-9]{40}$/.test(sha)) throw new Error('RELEASE_SHA must be an exact 40-character commit SHA');
    if (/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.exec(repo)?.[0] !== repo || ['.', '..'].includes(repo.split('/')[1]!)) throw new Error('GITHUB_REPOSITORY must be owner/name');

    const filename = `naru-${version}.tar.gz`, archive = `dist/${filename}`, checksum = `${archive}.sha256`;
    const checksumLine = await readFile(resolve(cwd, checksum), 'utf8');
    const expected = /^([a-f0-9]{64})  ([^\r\n]+)\n?$/.exec(checksumLine);
    if (!expected || expected[0] !== checksumLine || expected[2] !== filename) throw new Error('Archive checksum must contain the exact release filename');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(resolve(cwd, archive))) hash.update(chunk);
    if (hash.digest('hex') !== expected[1]) throw new Error('Archive checksum mismatch');

    async function command(args: string[], operation: string): Promise<string> {
        const result = await run(args, cwd);
        if (result.code !== 0) throw new Error(`${operation} failed; no automatic retry. Inspect the release before manually rerunning the failed job.`);
        return result.stdout;
    }
    async function verifyTag(): Promise<void> {
        const commit = object(await command(['api', `repos/${repo}/commits/${tag}`], 'Remote tag verification'));
        if (typeof commit.sha !== 'string' || commit.sha.toLowerCase() !== sha.toLowerCase()) throw new Error('Remote release tag does not match RELEASE_SHA');
    }
    async function lookup(): Promise<Release | null> {
        // GraphQL finds drafts as well as public releases; the REST tag lookup only finds published releases.
        const [owner, name] = repo.split('/');
        const result = await run(['api', 'graphql', '-f', `query=${releaseQuery}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `tag=${tag}`], cwd);
        if (result.code !== 0) throw new Error('Release lookup failed; no automatic retry');
        const response = object(result.stdout);
        if (('errors' in response && (!Array.isArray(response.errors) || response.errors.length !== 0))
            || !isObject(response.data) || !isObject(response.data.repository)) throw new Error('Release lookup failed; expected error-free repository data');
        const release = response.data.repository.release;
        if (release === null) return null;
        if (!isObject(release) || typeof release.databaseId !== 'number' || !Number.isSafeInteger(release.databaseId) || release.databaseId <= 0
            || release.tagName !== tag || typeof release.isDraft !== 'boolean') throw new Error('GitHub returned invalid release metadata');
        return { id: release.databaseId, tag_name: release.tagName, draft: release.isDraft };
    }

    const existing = await lookup();
    await verifyTag();
    if (existing && !existing.draft) return 'already-published';

    if (existing) {
        await command(['release', 'upload', tag, archive, checksum, '--repo', repo, '--clobber'], 'Draft asset upload');
    } else {
        // Keep partial uploads private, and never allow gh to create a missing tag.
        await command(['release', 'create', tag, archive, checksum, '--repo', repo, '--verify-tag', '--title', tag, '--generate-notes', '--target', sha, '--draft'], 'Draft release creation');
    }

    const ready = await lookup();
    if (!ready || (existing && ready.id !== existing.id)) throw new Error('Release changed during publication; inspect it before rerunning');
    await verifyTag();
    if (!ready.draft) return 'already-published';
    // No notes flags: preserve release-please's notes. No --latest: let GitHub choose by date/version.
    await command(['release', 'edit', tag, '--repo', repo, '--draft=false', '--verify-tag'], 'Draft publication');
    return 'published';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const result = await publishRelease();
        console.log(result === 'published' ? 'Qualified release published.' : 'Release already public; assets and notes left unchanged. This run did not publish its candidate.');
    } catch (error) {
        console.error(error instanceof Error ? error.message : 'Release publication failed');
        process.exitCode = 1;
    }
}
