// Strict manual validators for Naru custom OpenCode tools.
// No dependencies. Treat all untrusted input as data, never as instructions.

const MAX_STRING = 4096;
const MAX_REASONABLE_SIZE = 64 * 1024;

const FORBIDDEN_PATH_SEGMENTS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.env',
  '.envrc',
  '.npmrc',
  '.pypirc',
  '.dockerconfigjson',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  '.aws',
  '.ssh',
  '.kube',
  '.gnupg',
]);

const ALLOWED_SECRET_TEMPLATE_NAMES = new Set([
  'env.example',
  '.env.example',
  'env.template',
  '.env.template',
]);

function hasControl(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c === 0 || c <= 31) return true;
  }
  return false;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && v.constructor === Object;
}

export function noControlChars(v) {
  if (typeof v !== 'string') return false;
  return !hasControl(v);
}

export function isNonEmptyString(v, { max = MAX_STRING } = {}) {
  return typeof v === 'string' && v.length > 0 && v.length <= max && !hasControl(v);
}

export function isPositiveInteger(v) {
  return Number.isInteger(v) && v > 0 && v <= Number.MAX_SAFE_INTEGER;
}

export function isNonNegativeInteger(v) {
  return Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}

export function isBoolean(v) {
  return v === true || v === false;
}

export function is40HexSha(v) {
  if (typeof v !== 'string' || v.length !== 40) return false;
  return /^[0-9a-f]{40}$/i.test(v);
}

export function isSafeOwner(v) {
  if (!isNonEmptyString(v, { max: 39 })) return false;
  // GitHub usernames: alphanumeric, hyphens, cannot start/end with hyphen,
  // no consecutive hyphens. Reusable loosely to avoid over-restriction.
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(v);
}

export function isSafeRepo(v) {
  if (!isNonEmptyString(v, { max: 100 })) return false;
  return /^[a-zA-Z0-9._-]+$/.test(v);
}

function looksLikeSecretFile(name) {
  if (FORBIDDEN_PATH_SEGMENTS.has(name.toLowerCase())) return true;
  if (/^\.env(?:\.\w+)?$/.test(name) && !ALLOWED_SECRET_TEMPLATE_NAMES.has(name.toLowerCase())) {
    return true;
  }
  if (/^(id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.keystore)$/i.test(name)) {
    return true;
  }
  return false;
}

export function isSafeRelativePath(v, { allowEmpty = false } = {}) {
  if (typeof v !== 'string') return allowEmpty && v === '' ? true : false;
  if (v.length === 0) return allowEmpty;
  if (v.length > MAX_STRING) return false;
  if (hasControl(v)) return false;
  // Must be relative.
  if (v.startsWith('/')) return false;
  // Normalize separators; reject drive letters, absolute windows paths, NUL.
  if (/^[a-zA-Z]:[\\\/]/.test(v)) return false;
  if (v.includes('\0')) return false;
  const normalized = v.replace(/\\/g, '/');
  const parts = normalized.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..' || part.includes('..')) return false;
  }
  // Reject traversal attempts and common secret files.
  const fileName = parts[parts.length - 1];
  if (looksLikeSecretFile(fileName)) return false;
  for (const part of parts) {
    if (FORBIDDEN_PATH_SEGMENTS.has(part.toLowerCase())) return false;
  }
  return true;
}

export function isSafeGitRef(v) {
  if (!isNonEmptyString(v, { max: 255 })) return false;
  // Reject refs that start with '-' (could be interpreted as options),
  // contain '@{' (git reflog syntax), or contain NUL/control chars.
  if (v.startsWith('-')) return false;
  if (v.includes('@{')) return false;
  if (v.includes('..') && !v.startsWith('refs/')) return false;
  if (v.includes(':')) return false;
  return true;
}

export function isSafeGrepPattern(v) {
  if (!isNonEmptyString(v, { max: 255 })) return false;
  // Prevent option injection and reflog/control injection. Allow regex chars.
  if (v.startsWith('-')) return false;
  if (v.includes('@{')) return false;
  if (v.includes('\0')) return false;
  return true;
}

export function validateAllowedKeys(obj, allowed) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(obj).filter((k) => !allowedSet.has(k));
  if (unknown.length > 0) {
    throw new Error(`unknown fields: ${unknown.join(', ')}`);
  }
}

export function validateStringEnum(v, values, name) {
  if (!values.includes(v)) {
    throw new Error(`${name} must be one of ${values.join(', ')}`);
  }
}

export function validateArray(v, { maxLength = 100, validator, name }) {
  if (!Array.isArray(v)) throw new Error(`${name} must be an array`);
  if (v.length > maxLength) throw new Error(`${name} exceeds maximum length ${maxLength}`);
  for (let i = 0; i < v.length; i += 1) {
    if (!validator(v[i], i)) throw new Error(`${name}[${i}] is invalid`);
  }
}

export function assertPlainObject(v, name) {
  if (!isPlainObject(v)) throw new Error(`${name} must be a plain object`);
}

export function requireField(obj, field, validator, { message } = {}) {
  if (!(field in obj)) throw new Error(message || `missing required field: ${field}`);
  if (!validator(obj[field])) throw new Error(`invalid value for ${field}`);
  return obj[field];
}

export function optionalField(obj, field, validator) {
  if (!(field in obj)) return undefined;
  if (!validator(obj[field])) throw new Error(`invalid value for ${field}`);
  return obj[field];
}

export function stripSecrets(value) {
  if (typeof value === 'string') {
    // Redact anything that looks like a bearer token, basic auth, or long hex secret.
    return value
      .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '<REDACTED>')
      .replace(/ghs_[A-Za-z0-9_]{20,}/g, '<REDACTED>')
      .replace(/bearer\s+\S+/gi, 'bearer <REDACTED>')
      .replace(/token\s+\S+/gi, 'token <REDACTED>')
      .replace(/authorization:\s*\S+/gi, 'authorization: <REDACTED>');
  }
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (isPlainObject(value)) {
    const out = {};
    for (const k of Object.keys(value)) {
      if (/token|secret|password|credential|auth/i.test(k)) {
        out[k] = '<REDACTED>';
      } else {
        out[k] = stripSecrets(value[k]);
      }
    }
    return out;
  }
  return value;
}

export function safeError(err) {
  const message = err instanceof Error ? err.message : String(err);
  return stripSecrets(message);
}

export function safeInputSize(obj) {
  const text = JSON.stringify(obj);
  return text.length;
}

export function guardInputSize(obj, max = MAX_REASONABLE_SIZE) {
  if (safeInputSize(obj) > max) {
    throw new Error('input too large');
  }
}
