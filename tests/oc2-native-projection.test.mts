import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { projectOc2NativeAgents } from '../tools/naru-lib/oc2-native-projection.mjs';

test('native projection creates every role/model pair with exact models and final wildcard permission', () => {
    const references = ['fixture/team/alpha#high', 'other/model'];
    const projection = projectOc2NativeAgents(references);
    assert.equal(projection.agents.naru?.model, undefined);
    for (const role of ['reader', 'runner', 'writer'] as const) {
        assert.equal(projection.names[role].length, references.length);
        assert.deepEqual(projection.names[role], projectOc2NativeAgents(references).names[role]);
        for (const [index, name] of projection.names[role].entries()) {
            const agent = projection.agents[name]!;
            assert.equal(name.length <= 64, true);
            assert.equal(agent.mode, 'subagent');
            assert.equal(agent.hidden, true);
            assert.match(agent.description, new RegExp(references[index]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
            assert.deepEqual(agent.model, index === 0 ? { providerID: 'fixture', model: 'team/alpha', variant: 'high' } : { providerID: 'other', model: 'model' });
            assert.deepEqual(agent.permissions.at(-1), { action: '*', resource: '*', effect: 'allow' });
            assert.equal(agent.permissions.some(permission => permission.effect !== 'allow'), false);
            assert.match(agent.system, /advisory.*permits all current and future native and MCP tools/s);
        }
    }
    for (const agent of Object.values(projection.agents)) {
        assert.deepEqual(agent.permissions.at(-1), { action: '*', resource: '*', effect: 'allow' });
        assert.equal(agent.permissions.some(permission => permission.action.includes('mcp') || permission.effect !== 'allow'), false);
    }
    assert.match(projection.agents.naru!.system, /many concurrent native sessions/);
    assert.match(projection.agents.naru!.system, /User intent is the only source of authorization/);
    assert.match(projection.agents.naru!.system, /Delegate every workspace file write, including follow-up repairs, to a writer/);
    assert.match(projection.agents.naru!.system, /fixture\/team\/alpha#high/);
    assert.match(projection.agents.naru!.system, /other\/model/);
    assert.match(projection.agents.naru!.system, /do not block independent work behind unrelated results/);
    assert.match(projection.agents.naru!.system, /continue that worker or commission a bounded correction/);
    assert.match(projection.agents.naru!.system, /skill tool's `id` input/);
    assert.doesNotMatch(projection.agents.naru!.system, /do simple work directly/);
});

test('native coordination skills are present with beta-native IDs and bounded guidance', async () => {
    const expected = {
        'naru-coordinate': [/dispatch independent work concurrently/, /one writer to each exact write scope/, /session IDs/],
        'naru-select-workers': [/provider\/model reference/, /permission fact, not evidence of model quality/, /do not silently switch to a billed fallback/],
        'naru-evaluate': [/implementation competence, delegation quality, and routing quality/, /different root model family/, /Do not automatically edit user instructions/],
    } as const;
    for (const [id, patterns] of Object.entries(expected)) {
        const skill = await readFile(join(process.cwd(), 'tools/oc2-native-plugin/skills', id, 'SKILL.md'), 'utf8');
        assert.match(skill, new RegExp(`^---\\nname: ${id}\\n`));
        for (const pattern of patterns) assert.match(skill, pattern);
    }
});

test('native projection rejects malformed, duplicate, and oversized pools', () => {
    assert.throws(() => projectOc2NativeAgents(['missing-provider']), /Invalid enrolled catalogue reference/);
    assert.throws(() => projectOc2NativeAgents(['fixture/model', 'fixture/model']), /Duplicate native model reference/);
    assert.throws(() => projectOc2NativeAgents(Array.from({ length: 33 }, (_, index) => `fixture/model-${index}`)), /at most 32/);
});

test('native projection shares one explicit instruction snapshot and reserves advertised plugin capabilities', () => {
    const instructions = { sourcePath: '/home/user/instructions.md', canonicalPath: '/home/user/instructions.md', text: 'Prefer focused checks.', sha256: 'a'.repeat(64), byteLength: 22 };
    const projection = projectOc2NativeAgents(['fixture/model'], instructions);
    for (const agent of Object.values(projection.agents)) {
        assert.match(agent.system, /Global instructions snapshot sha256 a{64}/);
        assert.match(agent.system, /Prefer focused checks/);
        assert.match(agent.system, /fixed Naru role.*override/s);
    }
    for (const capability of ['naru-git-read', 'naru-github-read', 'naru-github-post-review', 'naru-worktree', 'naru-impact', 'naru-plan', 'naru-review', 'naru-triage']) {
        assert.match(projection.agents.naru!.system, new RegExp(capability));
        assert.match(projection.agents[projection.names.writer[0]!]!.system, new RegExp(capability));
    }
    assert.match(projection.agents.naru!.system, /only capabilities OpenCode actually advertises/);
});
