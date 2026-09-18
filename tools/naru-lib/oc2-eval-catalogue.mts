import type { PreviewCatalogue, PreviewCatalogueEntry } from './preview-process.mjs';

export const OC2_EVAL_SCHEMA_VERSION = 2 as const;

const REQUIRED_ROUTES = [
    'openai/gpt-5.6-luna-fast',
    'openai/gpt-5.6-sol-fast',
    'openai/gpt-5.6-terra-fast',
    'openai/gpt-6-astra-fast',
    'xai/grok-4.6',
] as const;

export interface EvaluationCatalogueRoute {
    routeID: string;
    providerID: string;
    modelID: string;
    upstreamModelID: string;
    name: string;
    variantIDs: string[];
    serviceTier: 'default' | 'fast' | 'priority' | 'unknown';
    requestSettings: { serviceTier?: 'priority'; speed?: 'fast'; reasoningMode?: 'pro' };
}

export interface EvaluationCatalogueSnapshot {
    schemaVersion: typeof OC2_EVAL_SCHEMA_VERSION;
    observedAt: string;
    source: { kind: 'native-host-catalogue'; metadataFreshness: 'unknown'; accountAccess: 'unknown' };
    routes: EvaluationCatalogueRoute[];
}

export interface EvaluationConfiguration {
    id: string;
    routeID: string;
    providerID: string;
    modelID: string;
    upstreamModelID: string;
    variant: string | null;
    reasoningLevel: string;
    serviceTier: EvaluationCatalogueRoute['serviceTier'];
    requestSettings: EvaluationCatalogueRoute['requestSettings'];
    costProvenance: { mode: 'subscription-only-authorization'; allowance: 'unknown'; cataloguePricesUsedForEligibility: false };
    status: 'blocked' | 'pending';
    blockedReason?: 'required-route-missing';
}

export interface EvaluationMatrix {
    schemaVersion: typeof OC2_EVAL_SCHEMA_VERSION;
    kind: 'task-conditioned-read-only';
    observedAt: string;
    generatedAt: string;
    limitations: string[];
    selection: {
        opencodeGoRoutes: number;
        advertisedFreeOpenCodeRoutes: number;
        requiredNamedRoutes: number;
        opencodeGoRouteIDs: string[];
        advertisedFreeOpenCodeRouteIDs: string[];
        requiredNamedRouteIDs: string[];
        fullConfigurationCount: number;
    };
    subset: {
        mode: 'full' | 'configuration-ids';
        requestedConfigurationIDs: string[];
        fullConfigurationCount: number;
        selectedConfigurationCount: number;
    };
    sampling: { exploratory: true; ranking: false; replicates: 1; order: 'route-then-variant' };
    configurations: EvaluationConfiguration[];
}

function requestSettings(entry: PreviewCatalogueEntry): EvaluationCatalogueRoute['requestSettings'] {
    const mode = entry.validationMode;
    return {
        ...(mode?.body?.service_tier === 'priority' ? { serviceTier: 'priority' as const } : {}),
        ...(mode?.body?.speed === 'fast' ? { speed: 'fast' as const } : {}),
        ...(mode?.body?.reasoning?.mode === 'pro' ? { reasoningMode: 'pro' as const } : {}),
    };
}

function tier(entry: PreviewCatalogueEntry, settings: EvaluationCatalogueRoute['requestSettings']): EvaluationCatalogueRoute['serviceTier'] {
    if (settings.serviceTier === 'priority') return 'priority';
    if (settings.speed === 'fast') return 'fast';
    if (entry.reference.endsWith('-fast')) return 'unknown';
    return 'default';
}

export function snapshotEvaluationCatalogue(catalogue: PreviewCatalogue): EvaluationCatalogueSnapshot {
    if (!catalogue.entries) throw new Error('Native catalogue entries are required for evaluation planning');
    const routes = catalogue.entries.filter(entry => entry.eligibility === 'eligible').map(entry => {
        const settings = requestSettings(entry);
        return {
            routeID: entry.reference,
            providerID: entry.providerID,
            modelID: entry.id,
            upstreamModelID: entry.upstreamModelID,
            name: entry.name,
            variantIDs: [...entry.variantIDs].sort(),
            serviceTier: tier(entry, settings),
            requestSettings: settings,
        } satisfies EvaluationCatalogueRoute;
    }).sort((left, right) => left.routeID.localeCompare(right.routeID));
    return {
        schemaVersion: OC2_EVAL_SCHEMA_VERSION,
        observedAt: catalogue.observedAt,
        source: { kind: 'native-host-catalogue', metadataFreshness: 'unknown', accountAccess: 'unknown' },
        routes,
    };
}

function isAdvertisedFreeOpenCode(route: EvaluationCatalogueRoute): boolean {
    if (route.providerID !== 'opencode') return false;
    const id = route.modelID.toLowerCase();
    return id.endsWith('-free') || id === 'big-pickle' || id === 'bigpickle';
}

function configuration(route: EvaluationCatalogueRoute, variant: string | null): EvaluationConfiguration {
    const reasoningLevel = variant ?? 'default';
    return {
        id: `${route.routeID}#${reasoningLevel}`,
        routeID: route.routeID,
        providerID: route.providerID,
        modelID: route.modelID,
        upstreamModelID: route.upstreamModelID,
        variant,
        reasoningLevel,
        serviceTier: route.serviceTier,
        requestSettings: { ...route.requestSettings },
        costProvenance: { mode: 'subscription-only-authorization', allowance: 'unknown', cataloguePricesUsedForEligibility: false },
        status: 'pending',
    };
}

export function buildEvaluationMatrix(snapshot: EvaluationCatalogueSnapshot, now = new Date(), requestedConfigurationIDs: readonly string[] = []): EvaluationMatrix {
    if (snapshot.schemaVersion !== OC2_EVAL_SCHEMA_VERSION || !Array.isArray(snapshot.routes)) throw new Error('Unsupported evaluation catalogue snapshot');
    const selected = snapshot.routes.filter(route => route.providerID === 'opencode-go' || isAdvertisedFreeOpenCode(route) || (REQUIRED_ROUTES as readonly string[]).includes(route.routeID));
    const selectedIDs = new Set(selected.map(route => route.routeID));
    const configurations = selected.flatMap(route => [configuration(route, null), ...route.variantIDs.map(variant => configuration(route, variant))]);
    for (const routeID of REQUIRED_ROUTES) if (!selectedIDs.has(routeID)) {
        const [providerID, ...model] = routeID.split('/');
        configurations.push({
            id: `${routeID}#default`, routeID, providerID: providerID!, modelID: model.join('/'), upstreamModelID: 'unknown', variant: null,
            reasoningLevel: 'default', serviceTier: routeID.endsWith('-fast') ? 'unknown' : 'default', requestSettings: {},
            costProvenance: { mode: 'subscription-only-authorization', allowance: 'unknown', cataloguePricesUsedForEligibility: false },
            status: 'blocked', blockedReason: 'required-route-missing',
        });
    }
    configurations.sort((left, right) => left.routeID.localeCompare(right.routeID) || (left.variant === null ? -1 : right.variant === null ? 1 : left.variant.localeCompare(right.variant)));
    const requested = [...requestedConfigurationIDs];
    if (new Set(requested).size !== requested.length) throw new Error('Matrix configuration subset contains duplicates');
    const known = new Set(configurations.map(item => item.id));
    for (const id of requested) if (!known.has(id)) throw new Error(`Unknown matrix configuration ID: ${id}`);
    const selectedConfigurations = requested.length ? configurations.filter(item => requested.includes(item.id)) : configurations;
    const goRoutes = selected.filter(route => route.providerID === 'opencode-go').map(route => route.routeID).sort();
    const freeRoutes = selected.filter(isAdvertisedFreeOpenCode).map(route => route.routeID).sort();
    const namedRoutes = selected.filter(route => (REQUIRED_ROUTES as readonly string[]).includes(route.routeID)).map(route => route.routeID).sort();
    return {
        schemaVersion: OC2_EVAL_SCHEMA_VERSION,
        kind: 'task-conditioned-read-only',
        observedAt: snapshot.observedAt,
        generatedAt: now.toISOString(),
        limitations: [
            'This matrix measures task-conditioned read-only responses without model tools; it is not a full agentic ranking.',
            'Agentic editing and test execution are not implemented because this pilot does not expose a credential-bearing host to model tools.',
            'Subscription allowance and monetary cost remain unknown. Catalogue prices do not authorize or reject routes.',
            'Each configuration receives one exploratory fixed-order sample. Results are not rankings.',
        ],
        selection: {
            opencodeGoRoutes: goRoutes.length, advertisedFreeOpenCodeRoutes: freeRoutes.length, requiredNamedRoutes: namedRoutes.length,
            opencodeGoRouteIDs: goRoutes, advertisedFreeOpenCodeRouteIDs: freeRoutes, requiredNamedRouteIDs: namedRoutes, fullConfigurationCount: configurations.length,
        },
        subset: { mode: requested.length ? 'configuration-ids' : 'full', requestedConfigurationIDs: requested, fullConfigurationCount: configurations.length, selectedConfigurationCount: selectedConfigurations.length },
        sampling: { exploratory: true, ranking: false, replicates: 1, order: 'route-then-variant' },
        configurations: selectedConfigurations,
    };
}
