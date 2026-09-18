import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { join } from 'node:path';
import plugin, { createOc2NativePlugin, OC2_NATIVE_TOOL_NAMES } from '../tools/oc2-native-plugin/index.mjs';
import gitReadTool from '../tools/naru-git-read.js';
import githubPostReviewTool from '../tools/naru-github-post-review.js';
import githubReadTool from '../tools/naru-github-read.js';
import worktreeTool from '../tools/naru-worktree.js';
import type { ProcessResult, Spawn, SpawnOptions } from '../tools/naru-lib/transport.mjs';

interface RegisteredTool {
    name: string;
    description: string;
    input: Record<string, unknown>;
    options: { codemode: boolean };
    execute(input: Record<string, unknown>, context: Record<string, unknown>): Promise<{ content: string }>;
}

function result(stdout = ''): ProcessResult {
    return { ok: true, code: 0, stdout, stderr: '', stdoutTruncated: false, stderrTruncated: false };
}

async function registered(adapters: Parameters<typeof createOc2NativePlugin>[0] = {}, resolvedDirectory?: string): Promise<Map<string, RegisteredTool>> {
    const tools = new Map<string, RegisteredTool>();
    await createOc2NativePlugin(adapters).setup({
        ...(resolvedDirectory ? { session: { async get() { return { directory: resolvedDirectory }; } } } : {}),
        tool: {
            async transform(callback) {
                callback({ add(tool) { tools.set(tool.name, tool as RegisteredTool); } });
            },
        },
    });
    return tools;
}

test('OC2 native plugin exports the proven package contract and exact tool inventory', async () => {
    assert.equal(plugin.id, 'naru.oc2-native');
    assert.deepEqual(OC2_NATIVE_TOOL_NAMES, [
        'naru-git-read',
        'naru-github-read',
        'naru-github-post-review',
        'naru-worktree',
    ]);
    const tools = await registered();
    assert.deepEqual([...tools.keys()], OC2_NATIVE_TOOL_NAMES);
    const legacy = [gitReadTool, githubReadTool, githubPostReviewTool, worktreeTool];
    for (const [index, tool] of [...tools.values()].entries()) {
        assert.ok(tool.description.length > 0);
        assert.deepEqual(tool.options, { codemode: false });
        assert.deepEqual(tool.input, {
            type: 'object', properties: legacy[index]!.args, required: Object.keys(legacy[index]!.args), additionalProperties: false,
        });
    }
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'tools/oc2-native-plugin/package.json'), 'utf8'));
    assert.deepEqual(manifest, { name: '@naru/oc2-native-plugin', version: '0.0.0', type: 'module', exports: './index.mjs' });
});

test('OC2 native tools use trusted host identity and reject argument impersonation', async () => {
    let spawnCalls = 0;
    const spawn: Spawn = async () => { spawnCalls++; return result(); };
    const tools = await registered({ spawn });
    const review = tools.get('naru-github-post-review')!;
    const fakeInput = { input: { agent: 'naru', reviewResult: {} } };

    const worker = JSON.parse((await review.execute(fakeInput, {
        agent: 'naru-writer-fixture', sessionID: 'worker-session', directory: process.cwd(), worktree: process.cwd(),
    })).content);
    assert.match(worker.error, /caller agent identity mismatch/);

    const parent = JSON.parse((await review.execute(fakeInput, {
        agent: 'naru', sessionID: 'parent-session', directory: process.cwd(), worktree: process.cwd(),
    })).content);
    assert.match(parent.error, /invalid input/);
    assert.doesNotMatch(parent.error, /identity mismatch/);
    assert.equal(spawnCalls, 0);
});

test('OC2 native tools propagate trusted direct and session-resolved directories and never accept a model cwd', async () => {
    const calls: Array<{ argv: string[]; options: SpawnOptions }> = [];
    const spawn: Spawn = async (argv, options = {}) => {
        calls.push({ argv, options });
        return result(' M fixture.txt\n');
    };
    const tools = await registered({ spawn });
    const git = tools.get('naru-git-read')!;
    const content = JSON.parse((await git.execute({
        input: { operation: 'status' },
        directory: '/model/supplied/directory',
        agent: 'naru',
    }, {
        agent: 'naru-reader-fixture',
        sessionID: 'trusted-session',
        directory: '/trusted/session/directory',
        worktree: '/trusted/session/worktree',
    })).content);
    assert.equal(content.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.options.cwd, '/trusted/session/worktree');

    const resolved = await registered({ spawn }, '/trusted/resolved/directory');
    await resolved.get('naru-git-read')!.execute({ input: { operation: 'status' }, directory: '/model/cwd' }, {
        agent: 'naru-reader-fixture', sessionID: 'resolved-session',
    });
    assert.equal(calls[1]!.options.cwd, '/trusted/resolved/directory');

    await assert.rejects(
        git.execute({ input: { operation: 'status' } }, { agent: 'naru', sessionID: 'missing-cwd' }),
        /per-session directory resolver/,
    );
});

test('OC2 worktree adapter uses beta-local runtime defaults without probing stable config', async () => {
    const tools = await registered({ worktreeRegistry: new Map() });
    const snapshot = JSON.parse((await tools.get('naru-worktree')!.execute({
        input: { operation: 'snapshot', runId: 'missing-run' },
        runtimeConfigPath: '/model/cannot/select/stable.json',
    }, {
        agent: 'naru', sessionID: 'parent-session', directory: process.cwd(), worktree: process.cwd(),
    })).content);
    assert.equal(snapshot.ok, false);
    assert.match(snapshot.error, /unknown worktree run/);
    assert.doesNotMatch(snapshot.error, /config|ENOENT/i);
});

test('OC2-native skill assets expose the four native skill IDs', async () => {
    for (const id of ['naru-impact', 'naru-plan', 'naru-review', 'naru-triage']) {
        const skill = await readFile(join(process.cwd(), 'tools/oc2-native-plugin/skills', id, 'SKILL.md'), 'utf8');
        assert.match(skill, new RegExp(`^---\\nname: ${id}\\n`));
    }
    const review = await readFile(join(process.cwd(), 'tools/oc2-native-plugin/skills/naru-review/SKILL.md'), 'utf8');
    assert.match(review, /actual host agent `naru`/);
    assert.match(review, /arguments cannot supply or impersonate that identity/);
});
