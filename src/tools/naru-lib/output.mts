// Standard response envelope for Naru custom tools.

export interface ToolEnvelope<TData = unknown, TError = unknown> {
  ok: boolean;
  tool: unknown;
  complete: boolean;
  contentTruncated: boolean;
  limits: object;
  warnings: unknown[];
  data: TData;
  error: TError;
}

export interface EnvelopeOptions<TData = unknown, TError = unknown> {
  ok?: unknown;
  tool?: unknown;
  complete?: unknown;
  contentTruncated?: unknown;
  limits?: unknown;
  warnings?: unknown;
  data?: TData | null;
  error?: TError | null;
}

export function makeEnvelope<TData = unknown, TError = unknown>({
  ok = false,
  tool,
  complete = false,
  contentTruncated = false,
  limits = {},
  warnings = [],
  data = null,
  error = null,
}: EnvelopeOptions<TData, TError> = {}): ToolEnvelope<TData | null, TError | null> {
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

export function okEnvelope<TData>(
  tool: unknown,
  data: TData,
  { complete = true, contentTruncated = false, limits = {}, warnings = [] }: EnvelopeOptions<TData> = {},
): ToolEnvelope<TData | null, null> {
  return makeEnvelope({ ok: true, tool, complete, contentTruncated, limits, warnings, data });
}

export function errEnvelope<TError>(
  tool: unknown,
  error: TError,
  { complete = false, warnings = [] }: EnvelopeOptions<null, TError> = {},
): ToolEnvelope<null, TError | null> {
  return makeEnvelope({ ok: false, tool, complete, warnings, error });
}
