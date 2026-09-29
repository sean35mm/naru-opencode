import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCatalogueReference } from '../tools/naru-lib/native-reader-projection.mjs';

test('catalogue references parse canonical IDs and variants and reject malformed input', () => {
    assert.deepEqual(parseCatalogueReference('fixture/team/model#high'), { providerID: 'fixture', model: 'team/model', variant: 'high' });
    assert.deepEqual(parseCatalogueReference('fixture/alpha'), { providerID: 'fixture', model: 'alpha' });
    for (const invalid of ['fixture', '/alpha', 'fixture/alpha#', 'fixture/alpha#high#other']) assert.throws(() => parseCatalogueReference(invalid), /Invalid/);
});
