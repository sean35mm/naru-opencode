// Standard response envelope for Naru custom tools.
export interface OutputEnvelope<TData = unknown, TError = unknown> {
    ok: boolean;
    tool: string | null;
    complete: boolean;
    contentTruncated: boolean;
    limits: object;
    warnings: unknown[];
    data: TData | null;
    error: TError | null;
}

export interface EnvelopeOptions<TData = unknown, TError = unknown> {
    ok?: unknown;
    tool?: string | null;
    complete?: unknown;
    contentTruncated?: unknown;
    limits?: unknown;
    warnings?: unknown;
    data?: TData | null;
    error?: TError | null;
}

export interface SuccessEnvelopeOptions {
    complete?: unknown;
    contentTruncated?: unknown;
    limits?: unknown;
    warnings?: unknown;
}

export interface ErrorEnvelopeOptions {
    complete?: unknown;
    warnings?: unknown;
}

export function makeEnvelope<TData = unknown, TError = unknown>({ ok = false, tool, complete = false, contentTruncated = false, limits = {}, warnings = [], data = null, error = null, }: EnvelopeOptions<TData, TError> = {}): OutputEnvelope<TData, TError> {
    return {
        ok: Boolean(ok),
        tool: tool || null,
        complete: Boolean(complete),
        contentTruncated: Boolean(contentTruncated),
        limits: limits && typeof limits === 'object' ? limits : {},
        warnings: Array.isArray(warnings) ? warnings : [],
        data,
        error,
    };
}
export function okEnvelope<TData>(tool: string, data: TData, { complete = true, contentTruncated = false, limits = {}, warnings = [] }: SuccessEnvelopeOptions = {}): OutputEnvelope<TData, never> {
    return makeEnvelope({ ok: true, tool, complete, contentTruncated, limits, warnings, data });
}
export function errEnvelope<TError>(tool: string, error: TError, { complete = false, warnings = [] }: ErrorEnvelopeOptions = {}): OutputEnvelope<never, TError> {
    return makeEnvelope({ ok: false, tool, complete, warnings, error });
}
