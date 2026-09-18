import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { readOc2SessionEvidence } from '../tools/naru-lib/oc2-session-evidence.mjs';
import { parseSessionReportArgs, runSessionReport } from '../tools/naru-session-report.mjs';

const now = Date.UTC(2026, 8, 15);
const secret = 'NEVER_REPORT_THIS_SECRET';

function createFixture(path: string): void {
    const db = new DatabaseSync(path);
    db.exec(`
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT, version TEXT, time_created INTEGER, time_updated INTEGER, parent_id TEXT, model TEXT, agent TEXT);
        CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT, type TEXT, seq INTEGER, time_updated INTEGER);
    `);
    const session = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    session.run('root-native-id', 'project', '/private/work/acme', null, '0.0.0-beta-19425', now - 10_000, now - 1_000, null, JSON.stringify({ id: 'requested-model', providerID: 'openai', variant: 'high' }), 'writer');
    session.run('child-native-id', 'project', '/private/work/acme', 'Child session', '0.0.0-beta-19271', now - 8_000, now - 2_000, 'root-native-id', JSON.stringify({ id: 'child-request', providerID: 'openai', variant: 'medium' }), 'writer');
    session.run('eval-id', 'project', '/private/work/acme', '[EVAL] excluded run', '0.0.0-beta-19425', now - 7_000, now - 1_500, null, '{}', 'writer');
    const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    message.run('m1', 'root-native-id', now - 9_000, JSON.stringify({ model: { id: 'actual-model', providerID: 'openai', variant: 'max' }, text: secret, retry: { message: secret }, content: [
        { type: 'reasoning', text: secret },
        { type: 'tool', name: 'patch', state: { status: 'completed', input: { patch: secret }, content: [{ text: secret }] } },
        { type: 'tool', name: 'patch', state: { status: 'error', input: { patch: secret }, error: { message: secret } } },
        { type: 'tool', name: 'subagent', state: { status: 'completed', input: { prompt: secret } } },
        { type: 'tool', name: `unknown-${secret}`, state: { status: 'streaming', input: { command: secret } } },
    ] }), 'assistant', 1, now - 3_000);
    message.run('m2', 'child-native-id', now - 7_000, JSON.stringify({ model: { id: 'child-actual', providerID: 'openai', variant: 'high' }, content: [
        { type: 'tool', name: 'write', state: { status: 'streaming', input: { path: secret } } },
        { type: 'tool', name: 'subagent', state: { status: 'completed', input: { sessionID: 'continuation-id', prompt: secret } } },
    ] }), 'assistant', 1, now - 4_000);
    message.run('m3', 'child-native-id', now - 6_000, '{ malformed secret', 'assistant', 2, now - 3_000);
    message.run('m4', 'eval-id', now - 6_000, JSON.stringify({ text: secret }), 'user', 1, now - 5_000);
    db.close();
}

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

test('normalizes root families, models, tool outcomes, retries, continuations, and privacy-safe metadata', async () => {
    const root = await mkdtemp('/tmp/naru-oc2-evidence-'), path = join(root, 'fixture.db');
    try {
        createFixture(path); const before = digest(await readFile(path));
        const report = readOc2SessionEvidence({ dbPath: path, since: now - 20_000, now, limit: 20 });
        assert.equal(report.schemaVersion, 1); assert.equal(report.excludedSessionCount, 1); assert.equal(report.sessions.length, 2); assert.equal(report.episodes.length, 1);
        assert.equal(report.source.loadedModelInventory, 'unknown'); assert.deepEqual(report.source.capturedProviderFields, ['id', 'providerID', 'variant']);
        const parent = report.sessions.find(item => item.depth === 0)!, child = report.sessions.find(item => item.depth === 1)!;
        assert.equal(parent.project, 'acme'); assert.equal(parent.origin.kind, 'unknown'); assert.equal(parent.origin.confidence, 'unknown');
        assert.equal(child.origin.kind, 'legacy-preview'); assert.equal(child.origin.confidence, 'known-host-version');
        assert.equal(parent.requestedModel?.id, 'requested-model'); assert.equal(parent.recordedModels[0]?.id, 'actual-model');
        assert.deepEqual(parent.tools.confirmedPatchWrites, { attempts: 2, completed: 1, errors: 1, interrupted: 0 });
        assert.deepEqual(child.tools.confirmedPatchWrites, { attempts: 1, completed: 0, errors: 0, interrupted: 1 });
        assert.equal(parent.providerRetryEvents, 1); assert.equal(report.malformedMessageCount, 1);
        assert.equal(report.episodes[0]?.distinctChildren, 1); assert.equal(report.episodes[0]?.sameRoleContinuations, 1);
        assert.equal(report.episodes[0]?.subagentCalls, 2); assert.equal(report.episodes[0]?.subagentContinuations, 1);
        assert.equal(report.episodes[0]?.temporalIntervalOverlap.maxOverlappingIntervals, 2);
        assert.equal(report.episodes[0]?.temporalIntervalOverlap.interpretation, 'recorded-interval-overlap-not-execution-or-concurrency');
        const serialized = JSON.stringify(report); assert.doesNotMatch(serialized, new RegExp(secret)); assert.doesNotMatch(serialized, /private\/work|root-native-id|child-native-id|continuation-id/);
        assert.equal(digest(await readFile(path)), before, 'read-only adapter must not change database bytes');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('handles malformed models and cycles without exposing raw identifiers', async () => {
    const root = await mkdtemp('/tmp/naru-oc2-cycle-'), path = join(root, 'fixture.db');
    try {
        createFixture(path); const db = new DatabaseSync(path);
        db.prepare('UPDATE session_v2 SET parent_id = ?, model = ? WHERE id = ?').run('child-native-id', '{bad', 'root-native-id'); db.close();
        const report = readOc2SessionEvidence({ dbPath: path, since: now - 20_000, now, limit: 20, includeExcludedOrigins: true });
        assert.equal(report.sessions.find(item => item.requestedModel === null)?.requestedModel, null);
        assert.equal(report.sessions.length, 3); assert.equal(report.episodes.length, 2);
        assert.equal(report.sessions.find(item => item.origin.kind === 'eval')?.origin.confidence, 'explicit-title-prefix');
        assert.doesNotMatch(JSON.stringify(report), /root-native-id|child-native-id/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('default filtering excludes tagged eval but retains tagged synthetic sessions', async () => {
    const root = await mkdtemp('/tmp/naru-oc2-origin-'), path = join(root, 'fixture.db');
    try {
        createFixture(path); const db = new DatabaseSync(path);
        db.prepare('UPDATE session_v2 SET title = ? WHERE id = ?').run('synthetic: retained fixture', 'eval-id'); db.close();
        const report = readOc2SessionEvidence({ dbPath: path, since: now - 20_000, now, limit: 20 });
        assert.equal(report.excludedSessionCount, 0);
        assert.equal(report.sessions.find(session => session.origin.kind === 'synthetic')?.origin.confidence, 'explicit-title-prefix');
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects unsupported schemas, missing paths, unbounded inputs, and implicit database fallback', async () => {
    const root = await mkdtemp('/tmp/naru-oc2-schema-'), path = join(root, 'unsupported.db');
    try {
        const db = new DatabaseSync(path); db.exec('CREATE TABLE session_v2 (id TEXT); CREATE TABLE session_message (id TEXT)'); db.close();
        assert.throws(() => readOc2SessionEvidence({ dbPath: path, since: now - 1_000, now }), /Unsupported OC2 database schema.*expected OC2-v2/);
        assert.throws(() => readOc2SessionEvidence({ dbPath: '', now }), /explicit OC2 database path/);
        assert.throws(() => readOc2SessionEvidence({ dbPath: join(root, 'missing.db'), since: now - 1_000, now }), /Unable to open.*read-only/);
        assert.throws(() => readOc2SessionEvidence({ dbPath: path, since: 0, now }), /bounded to the last 365 days/);
        assert.throws(() => readOc2SessionEvidence({ dbPath: path, since: now, now, limit: 5_001 }), /--limit must be between/);
        assert.throws(() => parseSessionReportArgs([]), /--db is required.*never selected implicitly/s);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI writes only to an explicit new absolute output and defaults to stdout', async () => {
    const root = await realpath(await mkdtemp('/tmp/naru-oc2-cli-')), path = join(root, 'fixture.db'), output = join(root, 'report.json');
    try {
        createFixture(path); let stdout = '';
        await runSessionReport(['--db', path, '--since', new Date(now - 20_000).toISOString(), '--limit', '20'], { write: value => { stdout += String(value); return true; } });
        assert.equal(JSON.parse(stdout).schemaVersion, 1); assert.equal((await readFile(path)).includes(Buffer.from(secret)), true);
        await runSessionReport(['--db', path, '--since', new Date(now - 20_000).toISOString(), '--output', output], { write: () => { throw new Error('unexpected stdout'); } });
        assert.equal(JSON.parse(await readFile(output, 'utf8')).schemaVersion, 1);
        await assert.rejects(runSessionReport(['--db', path, '--output', output]), /refusing to overwrite/);
        await assert.rejects(runSessionReport(['--db', path, '--output', 'relative.json']), /explicit absolute path/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('session limit is deterministic and bounds family input', async () => {
    const root = await mkdtemp('/tmp/naru-oc2-limit-'), path = join(root, 'fixture.db');
    try {
        createFixture(path);
        const report = readOc2SessionEvidence({ dbPath: path, since: now - 20_000, now, limit: 1, includeExcludedOrigins: true });
        assert.equal(report.sessions.length, 1); assert.equal(report.window.sessionLimit, 1); assert.equal(report.window.limitReached, true);
        assert.equal(report.episodes[0]?.completeness, 'incomplete');
        assert.deepEqual(report.episodes[0]?.warnings, ['omitted-children', 'session-limit-reached']);
        assert.deepEqual(report.warnings, ['root-families-may-be-incomplete-at-window-or-limit-boundary']);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects session ancestry beyond the recursion safety bound', async () => {
    const root = await mkdtemp('/tmp/naru-oc2-depth-'), path = join(root, 'fixture.db');
    try {
        createFixture(path); const db = new DatabaseSync(path);
        const insert = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        for (let index = 0; index < 66; index += 1) {
            insert.run(`deep-${String(index).padStart(2, '0')}`, 'project', '/work/acme', 'Deep family', '0.0.0-beta-19425', now - 5_000, now - 500, index === 0 ? null : `deep-${String(index - 1).padStart(2, '0')}`, '{}', 'writer');
        }
        db.close();
        assert.throws(() => readOc2SessionEvidence({ dbPath: path, since: now - 20_000, now, limit: 100, includeExcludedOrigins: true }), /exceeds the 64-level safety bound/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('flags an omitted parent instead of silently turning a child into a root', async () => {
    const root = await mkdtemp('/tmp/naru-oc2-parent-'), path = join(root, 'fixture.db');
    try {
        createFixture(path); const db = new DatabaseSync(path);
        db.prepare('UPDATE session_v2 SET time_updated = ? WHERE id = ?').run(now, 'child-native-id'); db.close();
        const report = readOc2SessionEvidence({ dbPath: path, since: now - 20_000, now, limit: 1, includeExcludedOrigins: true });
        assert.equal(report.sessions[0]?.familyComplete, false); assert.notEqual(report.sessions[0]?.id, report.sessions[0]?.rootId);
        assert.deepEqual(report.episodes[0]?.warnings, ['omitted-parent', 'session-limit-reached']);
        assert.deepEqual(report.episodes[0]?.parentLinks.map(link => link.parentIncluded), [false]);
        assert.equal(report.episodes[0]?.confirmedPatchWrites.parent.attempts, 0);
        assert.equal(report.episodes[0]?.subagentCalls, 1); assert.equal(report.episodes[0]?.subagentContinuations, 1);
    } finally { await rm(root, { recursive: true, force: true }); }
});
