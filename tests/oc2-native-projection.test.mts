import assert from 'node:assert/strict';
import test from 'node:test';
import { projectOc2NativeAgents } from '../tools/naru-lib/oc2-native-projection.mjs';

test('native projection creates one reusable worker per exact reference without permission or parent model overrides', () => {
    const references = ['fixture/team/alpha#high', 'fixture/team/alpha#low', 'other/model'];
    const projection = projectOc2NativeAgents(references);
    assert.deepEqual(projection.workers, projectOc2NativeAgents(references).workers);
    assert.equal(projection.workers.length, references.length);
    assert.equal(new Set(projection.workers.map(worker => worker.name)).size, references.length);
    assert.deepEqual(Object.keys(projection.agents).sort(), ['naru', ...projection.workers.map(worker => worker.name)].sort());
    for (const [index, { name, reference }] of projection.workers.entries()) {
        const agent = projection.agents[name]!;
        assert.match(name, /^naru-worker-/);
        assert.ok(name.length <= 64);
        assert.equal(reference, references[index]);
        assert.equal(agent.mode, 'subagent');
        assert.equal(agent.hidden, true);
        assert.deepEqual(agent.model, index === 2 ? { providerID: 'other', model: 'model' } : { providerID: 'fixture', model: 'team/alpha', variant: index === 0 ? 'high' : 'low' });
        assert.equal('permissions' in agent, false);
        assert.match(agent.system, /assignment.*determines whether you investigate, check, edit, or review/);
        assert.match(agent.system, /normally remain a leaf unless explicitly asked/);
    }
    assert.equal(projection.agents.naru!.model, undefined);
    assert.equal('permissions' in projection.agents.naru!, false);
    assert.match(projection.agents.naru!.system, /user chooses your model and effort/);
    assert.match(projection.agents.naru!.system, /delegate them in parallel/);
    assert.match(projection.agents.naru!.system, /narrow direct tasks, edits, and context reads/);
    assert.match(projection.agents.naru!.system, /fresh independent session for an independent review/);
    assert.match(projection.agents.naru!.system, /one owner per file or contract/);
    assert.match(projection.agents.naru!.system, /fixture\/team\/alpha#high/);
    assert.match(projection.agents.naru!.system, /never bypass a host permission denial/i);
});

test('native projection rejects malformed, duplicate, and oversized pools', () => {
    assert.throws(() => projectOc2NativeAgents(['missing-provider']), /Invalid enrolled catalogue reference/);
    assert.throws(() => projectOc2NativeAgents(['fixture/model', 'fixture/model']), /Duplicate native model reference/);
    assert.throws(() => projectOc2NativeAgents(Array.from({ length: 33 }, (_, index) => `fixture/model-${index}`)), /at most 32/);
});

test('explicit instruction snapshots cannot grant authorization or override host permissions', () => {
    const instructions = { sourcePath: '/home/user/instructions.md', canonicalPath: '/home/user/instructions.md', text: 'Prefer focused checks.', sha256: 'a'.repeat(64), byteLength: 22 };
    const projection = projectOc2NativeAgents(['fixture/model'], instructions);
    for (const agent of Object.values(projection.agents)) {
        assert.match(agent.system, /Global instructions snapshot sha256 a{64}/);
        assert.match(agent.system, /Prefer focused checks/);
        assert.match(agent.system, /preferences, not authorization/);
        assert.equal('permissions' in agent, false);
    }
});
