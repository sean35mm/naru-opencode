import { isSafeCatalogueModelID } from './preview-process.mjs';

export const MAX_CATALOGUE_REFERENCE_LENGTH = 128 + 1 + 512 + 1 + 128;

export function parseCatalogueReference(reference: string): { providerID: string; model: string; variant?: string } {
    if (reference.length > MAX_CATALOGUE_REFERENCE_LENGTH) throw new Error(`Invalid enrolled catalogue reference: ${reference}`);
    const slash = reference.indexOf('/');
    if (slash < 1 || slash === reference.length - 1) throw new Error(`Invalid enrolled catalogue reference: ${reference}`);
    const providerID = reference.slice(0, slash);
    const modelAndVariant = reference.slice(slash + 1);
    const hash = modelAndVariant.lastIndexOf('#');
    const model = hash < 0 ? modelAndVariant : modelAndVariant.slice(0, hash);
    const variant = hash < 0 ? undefined : modelAndVariant.slice(hash + 1);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(providerID)
        || !isSafeCatalogueModelID(model) || model.includes('#') || (variant !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(variant))) {
        throw new Error(`Invalid enrolled catalogue reference: ${reference}`);
    }
    return { providerID, model, ...(variant ? { variant } : {}) };
}
