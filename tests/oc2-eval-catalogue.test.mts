import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { buildEvaluationMatrix, type EvaluationCatalogueRoute, type EvaluationCatalogueSnapshot } from '../tools/naru-lib/oc2-eval-catalogue.mjs';

const route = (routeID: string, variants = ['low', 'high']): EvaluationCatalogueRoute => {
    const [providerID, ...model] = routeID.split('/'), modelID = model.join('/');
    return { routeID, providerID: providerID!, modelID, upstreamModelID: routeID.endsWith('-fast') ? modelID.slice(0, -5) : modelID, name: modelID, variantIDs: variants, serviceTier: routeID.endsWith('-fast') ? 'priority' : 'default', requestSettings: routeID.endsWith('-fast') ? { serviceTier: 'priority' } : {} };
};

test('matrix includes every Go route, seven advertised free routes, named subscription routes, defaults, and all variants deterministically', () => {
    const routes = [
        ...Array.from({ length: 27 }, (_, index) => route(`opencode-go/go-${String(index).padStart(2, '0')}`)),
        ...Array.from({ length: 6 }, (_, index) => route(`opencode/free-${index}-free`, [])),
        route('opencode/big-pickle', []),
        route('xai/grok-4.6', ['none', 'high']),
        ...['gpt-6-astra-fast', 'gpt-5.6-sol-fast', 'gpt-5.6-terra-fast', 'gpt-5.6-luna-fast'].map(id => route(`openai/${id}`, ['none', 'low', 'high', 'max'])),
        route('openai/not-authorized-paid-route', ['high']),
    ];
    const snapshot: EvaluationCatalogueSnapshot = { schemaVersion: 2, observedAt: '2026-09-15T00:00:00.000Z', source: { kind: 'native-host-catalogue', metadataFreshness: 'unknown', accountAccess: 'unknown' }, routes: [...routes].reverse() };
    const matrix = buildEvaluationMatrix(snapshot, new Date('2026-09-15T01:00:00.000Z'));
    assert.equal(matrix.selection.opencodeGoRoutes, 27); assert.equal(matrix.selection.advertisedFreeOpenCodeRoutes, 7); assert.equal(matrix.selection.requiredNamedRoutes, 5);
    assert.equal(matrix.selection.opencodeGoRouteIDs.length, 27); assert.equal(matrix.selection.advertisedFreeOpenCodeRouteIDs.length, 7); assert.equal(matrix.selection.requiredNamedRouteIDs.length, 5);
    assert.deepEqual(matrix.sampling, { exploratory: true, ranking: false, replicates: 1, order: 'route-then-variant' });
    assert.deepEqual(matrix.subset, { mode: 'full', requestedConfigurationIDs: [], fullConfigurationCount: matrix.configurations.length, selectedConfigurationCount: matrix.configurations.length });
    assert.equal(matrix.configurations.some(item => item.routeID === 'openai/not-authorized-paid-route'), false);
    for (const selected of routes.slice(0, -1)) {
        const configurations = matrix.configurations.filter(item => item.routeID === selected.routeID);
        assert.deepEqual(configurations.map(item => item.reasoningLevel), ['default', ...selected.variantIDs].sort((left, right) => left === 'default' ? -1 : right === 'default' ? 1 : left.localeCompare(right)));
    }
    const sol = matrix.configurations.find(item => item.routeID === 'openai/gpt-5.6-sol-fast' && item.variant === null)!;
    assert.equal(sol.upstreamModelID, 'gpt-5.6-sol'); assert.equal(sol.serviceTier, 'priority'); assert.equal(sol.requestSettings.serviceTier, 'priority');
    assert.deepEqual(matrix.configurations.map(item => item.id), [...matrix.configurations.map(item => item.id)].sort((left, right) => {
        const [leftRoute, leftVariant] = left.split('#'), [rightRoute, rightVariant] = right.split('#');
        return leftRoute!.localeCompare(rightRoute!) || (leftVariant === 'default' ? -1 : rightVariant === 'default' ? 1 : leftVariant!.localeCompare(rightVariant!));
    }));
});

test('an exact configuration subset preserves transparent full-inventory counts and fixed order', () => {
    const snapshot: EvaluationCatalogueSnapshot = { schemaVersion: 2, observedAt: '2026-09-15T00:00:00.000Z', source: { kind: 'native-host-catalogue', metadataFreshness: 'unknown', accountAccess: 'unknown' }, routes: [route('openai/gpt-6-astra-fast', ['high']), route('opencode-go/deepseek', ['high'])] };
    const full = buildEvaluationMatrix(snapshot), ids = ['openai/gpt-6-astra-fast#high', 'opencode-go/deepseek#default'];
    const subset = buildEvaluationMatrix(snapshot, new Date('2026-09-15T01:00:00.000Z'), ids);
    assert.deepEqual(subset.configurations.map(item => item.id), ids.slice().sort());
    assert.deepEqual(subset.subset, { mode: 'configuration-ids', requestedConfigurationIDs: ids, fullConfigurationCount: full.configurations.length, selectedConfigurationCount: 2 });
    assert.equal(subset.selection.fullConfigurationCount, full.configurations.length);
    assert.throws(() => buildEvaluationMatrix(snapshot, new Date(), ['missing/model#default']), /Unknown matrix configuration ID/);
});

test('missing named routes remain blocked while the observed free inventory is reported without a frozen expected count', async () => {
    const path = join(import.meta.dirname, '..', '..', 'tests', 'fixtures', 'oc2-eval', 'catalogue.json');
    const matrix = buildEvaluationMatrix(JSON.parse(await readFile(path, 'utf8')) as EvaluationCatalogueSnapshot);
    assert.ok(matrix.configurations.some(item => item.routeID === 'xai/grok-4.6' && item.status === 'blocked'));
    assert.equal(matrix.selection.advertisedFreeOpenCodeRoutes, 1);
    assert.deepEqual(matrix.selection.advertisedFreeOpenCodeRouteIDs, ['opencode/example-free']);
    assert.equal(JSON.stringify(matrix).includes('expectedAdvertised'), false);
});
