import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishRelease, type ReleaseCommandRunner } from '../scripts/naru-release-publish.mjs';

const sha = 'a'.repeat(40), tag = 'v1.2.3', repo = 'example/naru';
const env = { GITHUB_REPOSITORY: repo, RELEASE_TAG: tag, RELEASE_SHA: sha };
const archive = 'dist/naru-1.2.3.tar.gz', checksum = `${archive}.sha256`, content = 'qualified archive';
const digest = createHash('sha256').update(content).digest('hex');
const commit = { code: 0, stdout: JSON.stringify({ sha }), stderr: '' };
const ok = { code: 0, stdout: '', stderr: '' };
function response(body: unknown) {
    return { code: 0, stdout: JSON.stringify(body), stderr: '' };
}
function releaseResponse(release: unknown) {
    return response({ data: { repository: { release } } });
}
const draftRelease = { databaseId: 123, tagName: tag, isDraft: true };
const draft = releaseResponse(draftRelease);
const published = releaseResponse({ ...draftRelease, isDraft: false });
const absent = releaseResponse(null);
const lookupArgs = ['api', 'graphql', '-f', 'query=query($owner:String!,$name:String!,$tag:String!){repository(owner:$owner,name:$name){release(tagName:$tag){databaseId tagName isDraft}}}', '-f', 'owner=example', '-f', 'name=naru', '-f', `tag=${tag}`];
const commitArgs = ['api', `repos/${repo}/commits/${tag}`];
const uploadArgs = ['release', 'upload', tag, archive, checksum, '--repo', repo, '--clobber'];
const editArgs = ['release', 'edit', tag, '--repo', repo, '--draft=false', '--verify-tag'];

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
    const cwd = await mkdtemp(join(tmpdir(), 'naru-release-publish-'));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await mkdir(join(cwd, 'dist'));
    await writeFile(join(cwd, archive), content);
    await writeFile(join(cwd, checksum), `${digest}  naru-1.2.3.tar.gz\n`);
    return cwd;
}
function runner(results: Awaited<ReturnType<ReleaseCommandRunner>>[]) {
    const calls: string[][] = [];
    const run: ReleaseCommandRunner = async args => {
        calls.push(args);
        const next = results.shift();
        assert.ok(next, `Unexpected command: ${args.join(' ')}`);
        return next;
    };
    return { calls, run };
}

test('draft assets are replaced only before publication, retaining generated notes and automatic latest selection', async t => {
    const cwd = await fixture(t), { run, calls } = runner([draft, commit, ok, draft, commit, ok]);
    assert.equal(await publishRelease({ ...env, RELEASE_VERSION: '1.2.3' }, { cwd, run }), 'published');
    assert.deepEqual(calls, [lookupArgs, commitArgs, uploadArgs, lookupArgs, commitArgs, editArgs]);
});

test('explicit GraphQL null creates a draft with verified existing tag and generated notes, then rechecks before publishing', async t => {
    const cwd = await fixture(t), { run, calls } = runner([absent, commit, ok, draft, commit, ok]);
    assert.equal(await publishRelease(env, { cwd, run }), 'published');
    assert.deepEqual(calls, [lookupArgs, commitArgs,
        ['release', 'create', tag, archive, checksum, '--repo', repo, '--verify-tag', '--title', tag, '--generate-notes', '--target', sha, '--draft'],
        lookupArgs, commitArgs, editArgs]);
});

test('already-public release is honestly skipped without replacing assets or notes', async t => {
    const cwd = await fixture(t), { run, calls } = runner([published, commit]);
    assert.equal(await publishRelease(env, { cwd, run }), 'already-published');
    assert.deepEqual(calls, [lookupArgs, commitArgs]);
});

test('checksum tampering and wrong filenames fail before any network call', async t => {
    const cwd = await fixture(t), { run, calls } = runner([]);
    await writeFile(join(cwd, archive), 'tampered');
    await assert.rejects(publishRelease(env, { cwd, run }), /checksum mismatch/);
    for (const line of [`${digest}  other.tar.gz\n`, `${digest}  naru-1.2.3.tar.gz\nextra\n`, `${digest}  ../naru-1.2.3.tar.gz\n`]) {
        await writeFile(join(cwd, checksum), line);
        await assert.rejects(publishRelease(env, { cwd, run }), /exact release filename/);
    }
    assert.deepEqual(calls, []);
});

test('noncanonical inputs are rejected before network or file reads', async () => {
    const { run, calls } = runner([]);
    for (const tagValue of ['1.2.3', 'v01.2.3', 'v1.2.3-beta', 'v1.2', 'v1.2.3\n', 'v9007199254740992.0.0', 'v1.2.3/../x']) {
        await assert.rejects(publishRelease({ ...env, RELEASE_TAG: tagValue }, { run }), /RELEASE_TAG/);
    }
    for (const value of ['', 'main', 'a'.repeat(39), `${sha}\n`]) {
        await assert.rejects(publishRelease({ ...env, RELEASE_SHA: value }, { run }), /RELEASE_SHA/);
    }
    for (const value of ['', 'example', 'example/naru/extra', '-example/naru', 'example/..', 'example/naru\n']) {
        await assert.rejects(publishRelease({ ...env, GITHUB_REPOSITORY: value }, { run }), /GITHUB_REPOSITORY/);
    }
    await assert.rejects(publishRelease({ ...env, RELEASE_VERSION: '2.0.0' }, { run }), /RELEASE_VERSION/);
    assert.deepEqual(calls, []);
});

test('tag mismatch prevents draft upload, absent release creation, and public success', async t => {
    const cwd = await fixture(t);
    for (const release of [draft, absent, published]) {
        const { run, calls } = runner([release, { ...commit, stdout: JSON.stringify({ sha: 'b'.repeat(40) }) }]);
        await assert.rejects(publishRelease(env, { cwd, run }), /does not match RELEASE_SHA/);
        assert.deepEqual(calls, [lookupArgs, commitArgs]);
    }
});

test('auth, rate-limit, server, and transport failures never become release absence', async t => {
    const cwd = await fixture(t);
    for (const failure of [
        ...[401, 403, 429, 500].map(status => ({ code: 1, stdout: JSON.stringify({ message: 'Request failed', status }), stderr: '' })),
        { code: 1, stdout: '', stderr: 'HTTP 404: a misleading message' },
        { code: 1, stdout: absent.stdout, stderr: 'failed despite partial output' },
        { code: null, stdout: absent.stdout, stderr: 'timed out' },
        { code: 0, stdout: '{}', stderr: '' }]) {
        const { run, calls } = runner([failure]);
        await assert.rejects(publishRelease(env, { cwd, run }), /Release lookup failed/);
        assert.deepEqual(calls, [lookupArgs]);
    }
});

test('GraphQL errors, including HTTP-success partial data, never permit creation or mutation', async t => {
    const cwd = await fixture(t);
    for (const release of [null, draftRelease, { ...draftRelease, isDraft: false }]) {
        for (const errors of [[{ message: 'Forbidden' }], [null], 'unexpected', null]) {
            const { run, calls } = runner([response({ data: { repository: { release } }, errors })]);
            await assert.rejects(publishRelease(env, { cwd, run }), /Release lookup failed/);
            assert.deepEqual(calls, [lookupArgs]);
        }
    }
});

test('missing or malformed GraphQL repository data is not release absence', async t => {
    const cwd = await fixture(t);
    for (const body of [{}, { data: null }, { data: [] }, { data: {} }, { data: { repository: null } },
        { data: { repository: [] } }, { data: { repository: {} } }, { data: { repository: { release: false } } }]) {
        const { run, calls } = runner([response(body)]);
        await assert.rejects(publishRelease(env, { cwd, run }), /Release lookup failed|invalid release metadata/);
        assert.deepEqual(calls, [lookupArgs]);
    }
    for (const stdout of ['not json', 'null', '[]']) {
        const { run, calls } = runner([{ code: 0, stdout, stderr: '' }]);
        await assert.rejects(publishRelease(env, { cwd, run }), /invalid JSON|invalid object/);
        assert.deepEqual(calls, [lookupArgs]);
    }
});

test('invalid release metadata fails closed', async t => {
    const cwd = await fixture(t);
    for (const value of [{ ...draftRelease, tagName: 'v9.9.9' }, { databaseId: 123, tagName: tag }, { tagName: tag, isDraft: true },
        { ...draftRelease, databaseId: '123' }, { ...draftRelease, databaseId: 0 }, { ...draftRelease, databaseId: 1.5 }]) {
        const { run, calls } = runner([releaseResponse(value)]);
        await assert.rejects(publishRelease(env, { cwd, run }), /invalid release metadata/);
        assert.deepEqual(calls, [lookupArgs]);
    }
});

test('failed upload or create is not retried and never publishes', async t => {
    const cwd = await fixture(t);
    for (const release of [draft, absent]) {
        const { run, calls } = runner([release, commit, { code: 1, stdout: '', stderr: 'unknown remote outcome' }]);
        await assert.rejects(publishRelease(env, { cwd, run }), /no automatic retry/);
        assert.equal(calls.length, 3);
        assert.ok(!calls.some(args => args[1] === 'edit'));
    }
});

test('moved tag after upload prevents final publication', async t => {
    const cwd = await fixture(t), { run, calls } = runner([draft, commit, ok, draft, { ...commit, stdout: JSON.stringify({ sha: 'b'.repeat(40) }) }]);
    await assert.rejects(publishRelease(env, { cwd, run }), /does not match RELEASE_SHA/);
    assert.deepEqual(calls, [lookupArgs, commitArgs, uploadArgs, lookupArgs, commitArgs]);
});

test('concurrently published release is not edited and is reported as already public', async t => {
    const cwd = await fixture(t), { run, calls } = runner([draft, commit, ok, published, commit]);
    assert.equal(await publishRelease(env, { cwd, run }), 'already-published');
    assert.deepEqual(calls, [lookupArgs, commitArgs, uploadArgs, lookupArgs, commitArgs]);
});

test('publication with an unknown outcome is never retried', async t => {
    const cwd = await fixture(t), { run, calls } = runner([draft, commit, ok, draft, commit, { code: null, stdout: '', stderr: 'timeout' }]);
    await assert.rejects(publishRelease(env, { cwd, run }), /Draft publication failed; no automatic retry/);
    assert.deepEqual(calls, [lookupArgs, commitArgs, uploadArgs, lookupArgs, commitArgs, editArgs]);
});
