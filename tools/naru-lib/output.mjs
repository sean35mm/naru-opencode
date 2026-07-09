// Standard response envelope for Naru custom tools.

export function makeEnvelope({ ok = false, tool, complete = false, contentTruncated = false, limits = {}, warnings = [], data = null, error = null } = {}) {
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

export function okEnvelope(tool, data, { complete = true, contentTruncated = false, limits = {}, warnings = [] } = {}) {
  return makeEnvelope({ ok: true, tool, complete, contentTruncated, limits, warnings, data });
}

export function errEnvelope(tool, error, { complete = false, warnings = [] } = {}) {
  return makeEnvelope({ ok: false, tool, complete, warnings, error });
}
