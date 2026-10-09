import assert from 'node:assert/strict';
import test from 'node:test';
import { projectOc2NativeAgents } from '../tools/naru-lib/oc2-native-projection.mjs';

const FULL_PERMISSIONS = [{ action: '*', effect: 'allow', resource: '*' }];

test('native projection creates one reusable worker per exact reference with allow-all permissions and no parent model override', () => {
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
        assert.equal('hidden' in agent, false);
        assert.deepEqual(agent.model, index === 2 ? { providerID: 'other', model: 'model' } : { providerID: 'fixture', model: 'team/alpha', variant: index === 0 ? 'high' : 'low' });
        assert.deepEqual(agent.permissions, FULL_PERMISSIONS);
        assert.match(agent.system, /do not ask the user to approve routine in-scope tool use/);
        assert.match(agent.system, /assignment.*determines whether you investigate, check, edit, or review/);
        assert.match(agent.system, /normally remain a leaf unless explicitly asked/);
    }
    assert.equal(projection.agents.naru!.model, undefined);
    assert.deepEqual(projection.agents.naru!.permissions, FULL_PERMISSIONS);
    assert.match(projection.agents.naru!.system, /do not ask the user to approve routine in-scope tool use/);
    assert.match(projection.agents.naru!.system, /user chooses your model and effort/);
    assert.match(projection.agents.naru!.system, /delegate them in parallel/);
    assert.match(projection.agents.naru!.system, /narrow direct tasks, edits, and context reads/);
    assert.match(projection.agents.naru!.system, /fresh independent session for an independent review/);
    assert.match(projection.agents.naru!.system, /one owner per file or contract/);
    assert.match(projection.agents.naru!.system, /fixture\/team\/alpha#high/);
    assert.match(projection.agents.naru!.system, /native general subagent is also valid/);
    assert.match(projection.agents.naru!.system, /model and effort together/);
    assert.match(projection.agents.naru!.system, /receipt marked running is not a child outcome/);
    assert.match(projection.agents.naru!.system, /native child session ID/);
    assert.match(projection.agents.naru!.system, /state what remains pending/);
    assert.match(projection.agents.naru!.system, /never bypass a host permission denial/i);
    const [long] = projectOc2NativeAgents(['opencode-go/deepseek-v4.1-flash#high']).workers;
    assert.match(long!.name, /^naru-worker-opencode-go-deepseek-v4-1-flash-high-[0-9a-f]{10}$/);
});

test('coordinator includes evidence-based selection and bounded exploration without loading a skill', () => {
    const { agents } = projectOc2NativeAgents(['fixture/model#low', 'other/model#high']);
    const prompt = agents.naru!.system;
    assert.match(prompt, /Honor the user's requested model or constraints first/);
    assert.match(prompt, /configured facts, provisional suitability judgments, and measured evidence distinct/);
    assert.match(prompt, /model's name, provider, inventory position, or similarity to the parent alone/);
    assert.match(prompt, /Successful completion does not establish comparative superiority/);
    assert.match(prompt, /concrete basis, not just the task's difficulty; acknowledge when the choice is provisional/);
    assert.match(prompt, /bounded, low-risk work that already needs delegation, consider an untried or less-observed candidate/);
    assert.match(prompt, /Do not create extra assignments, impose provider quotas, or rotate models for appearance/);
    assert.match(prompt, /weak evidence calls for stronger verification, not arbitrary exploration/);
    assert.match(prompt, /context retention is not evidence of general model superiority/);
    assert.match(prompt, /changing models alone does not establish review independence or quality/);
    assert.match(prompt, /distinguish missing tools or permissions, missing context or unclear scope, execution or reasoning errors, and interrupted or unobservable outcomes/);
    assert.match(prompt, /a tool-access failure is not evidence of poor model reasoning/);
});

test('coordinator makes explicit pooled-model requests dispatch instructions rather than preferences', () => {
    const { agents } = projectOc2NativeAgents(['fixture/model#low', 'fixture/model#high']);
    const prompt = agents.naru!.system;
    assert.match(prompt, /resolve the request against the configured worker inventory, accepting unambiguous friendly names/);
    assert.match(prompt, /Dispatch the requested task through the matching native worker even if you would otherwise handle it directly/);
    assert.match(prompt, /Honor a specified effort exactly; if omitted, choose a configured effort for that model/);
    assert.match(prompt, /model, provider, or version remains ambiguous, ask one concise clarifying question before dispatch/);
    assert.match(prompt, /requested model or effort is absent from the pool, report that and do not dispatch a substitute/);
    assert.match(prompt, /Do not bypass the pool with a model override, use general as a substitute, change the parent model, or alter the pool/);
    assert.match(prompt, /Do not continue a session running a different model or effort/);
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
        assert.deepEqual(agent.permissions, FULL_PERMISSIONS);
    }
});
