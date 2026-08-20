// Read-only GitHub operations for naru-github-read. All gh calls use fixed argv
// with `gh api --method GET`. No arbitrary endpoints, methods, headers, or tokens.
import { createHash } from 'node:crypto';
import { run } from './transport.mjs';
import { isSafeOwner, isSafeRepo, isPositiveInteger, is40HexSha, isSafeRelativePath, isNonEmptyString, stripSecrets, } from './validate.mjs';
const MAX_GH_BYTES = 32 * 1024 * 1024;
const MAX_CHANGED_FILES = 3000;
const MAX_BODY_LENGTH = 64 * 1024;
const MAX_ITEMS = 1000;
const MAX_REVIEWABILITY_LIMITATIONS = 100;
const MAX_PATCH_BYTES_PER_FILE = 1024 * 1024;
const MAX_TOTAL_PATCH_BYTES = 16 * 1024 * 1024;
const MAX_LINE_MAP_ENTRIES_PER_FILE = 1024;
const MAX_LINE_MAP_ENTRIES_PER_BATCH = 16 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_PULL_FILE_BATCH = 100;
const FEEDBACK_PAGE_SIZE = 100;
const EVIDENCE_FILE_PAGE_SIZE = 16;
const PULL_FILE_STATUSES = new Set(['added', 'removed', 'modified', 'renamed', 'copied', 'changed', 'unchanged']);
const COMPACT_FILES_JQ = 'map({filename,previous_filename,status,sha,additions,deletions,changes})';
const COMPACT_FEEDBACK_JQ = 'map({id,state,commit_id,path,line,side,created_at,updated_at,submitted_at})';
const BOUNDED_FEEDBACK_JQ = 'map({id,state,commit_id,path,line,side,created_at,updated_at,submitted_at,html_url,url,body,user:{login:.user.login}})';
const EVIDENCE_FILE_JQ = `(.patch // null) as $patch | (($patch // "") | utf8bytelength) as $patch_bytes | {filename,previous_filename,status,sha,additions,deletions,changes,patch_bytes:$patch_bytes,patch_oversized:($patch_bytes > ${MAX_PATCH_BYTES_PER_FILE}),patch_base64:(if $patch != null and $patch_bytes <= ${MAX_PATCH_BYTES_PER_FILE} then ($patch | @base64) else null end)}`;
const EVIDENCE_FILES_JQ = `map(${EVIDENCE_FILE_JQ})`;
const FEEDBACK_KINDS = Object.freeze({
    reviews: target => `repos/${target.owner}/${target.repo}/pulls/${target.number}/reviews`,
    'review-comments': target => `repos/${target.owner}/${target.repo}/pulls/${target.number}/comments`,
    'issue-comments': target => `repos/${target.owner}/${target.repo}/issues/${target.number}/comments`,
});
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function record(value, label) {
    if (!isRecord(value))
        throw new Error(`${label} must be an object`);
    return value;
}
function stringField(value) {
    return typeof value === 'string' ? value : undefined;
}
function numberField(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function loginField(value) {
    if (!isRecord(value))
        return undefined;
    return { login: stringField(value.login) };
}
function repositoryField(value) {
    if (!isRecord(value))
        return undefined;
    return { name: stringField(value.name), owner: loginField(value.owner) };
}
function pullRefField(value) {
    if (!isRecord(value))
        return undefined;
    return {
        sha: stringField(value.sha),
        ref: stringField(value.ref),
        repo: repositoryField(value.repo),
    };
}
function normalizePullMetadata(value) {
    const item = record(value, 'pull metadata');
    return {
        title: stringField(item.title),
        body: stringField(item.body),
        state: stringField(item.state),
        draft: typeof item.draft === 'boolean' ? item.draft : undefined,
        html_url: stringField(item.html_url),
        user: loginField(item.user),
        base: pullRefField(item.base),
        head: pullRefField(item.head),
        changed_files: numberField(item.changed_files),
        updated_at: stringField(item.updated_at),
    };
}
function normalizePullFile(value) {
    const item = record(value, 'pull file');
    return {
        filename: stringField(item.filename),
        previous_filename: stringField(item.previous_filename),
        status: stringField(item.status),
        sha: stringField(item.sha),
        additions: numberField(item.additions),
        deletions: numberField(item.deletions),
        changes: numberField(item.changes),
        patch: stringField(item.patch),
        patch_bytes: numberField(item.patch_bytes),
        patch_oversized: item.patch_oversized === true,
    };
}
function normalizeFeedback(value) {
    const item = record(value, 'GitHub feedback item');
    return {
        id: item.id,
        state: stringField(item.state),
        commit_id: stringField(item.commit_id),
        body: stringField(item.body),
        user: loginField(item.user),
        path: stringField(item.path),
        line: numberField(item.line),
        side: stringField(item.side),
        created_at: stringField(item.created_at),
        updated_at: stringField(item.updated_at),
        submitted_at: stringField(item.submitted_at),
        html_url: stringField(item.html_url),
        url: stringField(item.url),
    };
}
function normalizeFeedbackArray(value, label) {
    if (!Array.isArray(value))
        throw new Error(`${label} must be an array`);
    return value.map(normalizeFeedback);
}
function normalizeFileArray(value) {
    if (!Array.isArray(value))
        throw new Error('pull files response must be an array');
    return value.map(normalizePullFile);
}
function normalizeEvidenceFileArray(value) {
    if (!Array.isArray(value))
        throw new Error('projected evidence files response must be an array');
    return value.map(raw => {
        const item = record(raw, 'projected evidence file');
        const patchBytes = numberField(item.patch_bytes);
        if (!Number.isSafeInteger(patchBytes) || patchBytes < 0 || typeof item.patch_oversized !== 'boolean')
            throw new Error('projected evidence file has invalid patch bounds');
        let patch;
        if (item.patch_base64 !== null && item.patch_base64 !== undefined) {
            if (typeof item.patch_base64 !== 'string' || item.patch_oversized)
                throw new Error('projected evidence file has invalid patch encoding');
            const decoded = Buffer.from(item.patch_base64, 'base64');
            if (decoded.toString('base64') !== item.patch_base64 || decoded.length !== patchBytes
                || patchBytes > MAX_PATCH_BYTES_PER_FILE)
                throw new Error('projected evidence file patch encoding failed validation');
            patch = decoded.toString('utf8');
            if (Buffer.byteLength(patch, 'utf8') !== patchBytes)
                throw new Error('projected evidence file patch is not valid UTF-8');
        }
        else if (!item.patch_oversized && patchBytes !== 0) {
            throw new Error('projected evidence file omitted a bounded patch');
        }
        return normalizePullFile({ ...item, patch, patch_bytes: patchBytes });
    });
}
export function hashString(s) {
    return createHash('sha256').update(s).digest('hex');
}
function normalizedPreviousPath(file) {
    const value = file.previous_filename ?? file.previousFilename ?? file.previousPath;
    return typeof value === 'string' ? value : null;
}
function fileDigest(files) {
    return hashString(JSON.stringify(files.map(file => ({
        filename: file.filename,
        previousFilename: normalizedPreviousPath(file),
        status: file.status,
        sha: file.sha,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
    })).sort((a, b) => String(a.filename ?? '').localeCompare(String(b.filename ?? '')))));
}
function identityFields(value) {
    return {
        owner: value.owner,
        repo: value.repo,
        number: value.number,
        baseSha: value.baseSha,
        headSha: value.headSha,
        snapshotId: value.snapshotId,
        feedbackDigest: value.feedbackDigest,
        evidenceDigest: value.evidenceDigest,
    };
}
function assertManifestIdentity(expected, actual, label = 'manifest') {
    const a = identityFields(expected);
    const b = identityFields(actual);
    if (a.owner.toLowerCase() !== b.owner.toLowerCase() || a.repo.toLowerCase() !== b.repo.toLowerCase()
        || a.number !== b.number || a.baseSha !== b.baseSha || a.headSha !== b.headSha
        || a.snapshotId !== b.snapshotId || a.feedbackDigest !== b.feedbackDigest
        || a.evidenceDigest !== b.evidenceDigest)
        throw new Error(`${label} identity mismatch`);
}
export function snapshotId(owner, repo, number, headSha, baseSha = '', files = []) {
    return `naru-snap-${hashString(JSON.stringify({
        owner,
        repo,
        number,
        headSha,
        baseSha,
        files: fileDigest(files),
    }))}`;
}
export function digestSnapshot(meta, files, reviews, reviewComments, issueComments) {
    const normalize = (items) => items.map(item => ({
        id: item.id,
        state: item.state,
        commitId: item.commit_id ?? item.commitId,
        path: item.path,
        line: item.line,
        side: item.side,
        updatedAt: item.updated_at ?? item.submitted_at ?? item.updatedAt,
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return hashString(JSON.stringify({
        headSha: meta.head?.sha || '',
        baseSha: meta.base?.sha || '',
        pullTitle: hashString(typeof meta.title === 'string' ? meta.title : ''),
        pullBody: hashString(typeof meta.body === 'string' ? meta.body : ''),
        pullUpdatedAt: meta.updated_at ?? meta.updatedAt,
        files: fileDigest(files),
        reviews: normalize(reviews),
        reviewComments: normalize(reviewComments),
        issueComments: normalize(issueComments),
    }));
}
export function digestEvidence(headSha, baseSha, files) {
    return hashString(JSON.stringify({
        headSha,
        baseSha,
        files: files.map(file => ({
            path: file.filename,
            previousPath: normalizedPreviousPath(file),
            status: file.status,
            sha: file.sha,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
        })).sort((a, b) => String(a.path ?? '').localeCompare(String(b.path ?? ''))),
    }));
}
function boundText(value, max) {
    if (typeof value !== 'string')
        return '';
    if (value.length <= max)
        return value;
    return value.slice(0, max) + '\n…[truncated]';
}
function boundItems(arr, max, warnings) {
    if (arr.length <= max)
        return arr;
    warnings.push(`capped item list at ${max}`);
    return arr.slice(0, max);
}
export function parseReference(reference) {
    if (!isNonEmptyString(reference, { max: 512 })) {
        throw new Error('reference must be a non-empty string');
    }
    const trimmed = reference.trim();
    if (trimmed.startsWith('https://')) {
        let url;
        try {
            url = new URL(trimmed);
        }
        catch {
            throw new Error('invalid GitHub URL');
        }
        if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) {
            throw new Error('URL must be an https://github.com issue or pull request URL');
        }
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 4 || (parts[2] !== 'pull' && parts[2] !== 'issues')) {
            throw new Error('URL must identify one issue or pull request');
        }
        const owner = parts[0];
        const repo = parts[1];
        const kind = parts[2];
        const number = Number(parts[3]);
        if (!isSafeOwner(owner) || !isSafeRepo(repo) || !isPositiveInteger(number)) {
            throw new Error('invalid owner/repo/number in URL');
        }
        return { owner, repo, number, kind: kind === 'issues' ? 'issue' : 'pull' };
    }
    const hashMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)#(\d+)$/);
    if (hashMatch) {
        const owner = hashMatch[1];
        const repo = hashMatch[2];
        const number = Number.parseInt(hashMatch[3] ?? '', 10);
        if (!isSafeOwner(owner) || !isSafeRepo(repo) || !isPositiveInteger(number)) {
            throw new Error('invalid owner/repo/number');
        }
        return { owner, repo, number, kind: 'pull' };
    }
    const spaceMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)\s+(\d+)$/);
    if (spaceMatch) {
        const owner = spaceMatch[1];
        const repo = spaceMatch[2];
        const number = Number.parseInt(spaceMatch[3] ?? '', 10);
        if (!isSafeOwner(owner) || !isSafeRepo(repo) || !isPositiveInteger(number)) {
            throw new Error('invalid owner/repo/number');
        }
        return { owner, repo, number, kind: 'pull' };
    }
    if (/^\d+$/.test(trimmed)) {
        const number = Number.parseInt(trimmed, 10);
        if (!isPositiveInteger(number))
            throw new Error('invalid number');
        return { number, bare: true };
    }
    throw new Error('could not parse reference');
}
export async function resolveBareNumber(number, context, { spawn } = {}) {
    const cwd = context?.worktree || context?.directory;
    if (typeof cwd !== 'string' || !cwd.startsWith('/')) {
        throw new Error('context worktree/directory required to resolve bare number');
    }
    const result = await run(['gh', 'repo', 'view', '--json', 'owner,name'], { spawn, cwd, maxBytes: MAX_GH_BYTES });
    if (result.stdoutTruncated)
        throw new Error('bounded gh repo view response was truncated');
    if (!result.ok) {
        throw new Error(`gh repo view failed: ${result.stderr || result.stdout}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        throw new Error('non-JSON gh repo view response');
    }
    const data = record(parsed, 'gh repo view response');
    const owner = loginField(data.owner)?.login;
    const repo = stringField(data.name);
    if (!isSafeOwner(owner) || !isSafeRepo(repo)) {
        throw new Error('gh repo view returned invalid owner/repo');
    }
    return { owner, repo, number };
}
async function ghApi(path, { spawn, paginate = false, jq } = {}) {
    if (paginate && jq !== undefined)
        throw new Error('projected GitHub pagination must use explicit bounded pages');
    const argv = ['gh', 'api', '--method', 'GET'];
    if (paginate)
        argv.push('--paginate', '--slurp');
    if (jq !== undefined)
        argv.push('--jq', jq);
    argv.push(path);
    const result = await run(argv, { spawn, maxBytes: MAX_GH_BYTES });
    if (result.stdoutTruncated)
        throw new Error(`bounded GitHub response was truncated for ${path}`);
    if (!result.ok) {
        throw new Error(stripSecrets(result.stderr || result.stdout || `gh api GET ${path} failed`));
    }
    let data;
    try {
        data = JSON.parse(result.stdout);
    }
    catch {
        throw new Error('non-JSON gh response');
    }
    if (paginate && Array.isArray(data)) {
        const flat = [];
        for (const page of data) {
            if (Array.isArray(page))
                flat.push(...page);
            else
                flat.push(page);
        }
        return flat;
    }
    return data;
}
async function consumeGhApiProjectedPages(path, { spawn, jq, totalItems, itemCeiling, pageSize = FEEDBACK_PAGE_SIZE }, consume) {
    if (typeof jq !== 'string' || jq.length === 0)
        throw new Error('projected GitHub pagination requires a fixed jq program');
    if (!Number.isSafeInteger(itemCeiling) || itemCeiling < 1)
        throw new Error('projected GitHub pagination requires a positive item ceiling');
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > FEEDBACK_PAGE_SIZE)
        throw new Error('projected GitHub pagination requires a page size from 1 to 100');
    if (totalItems !== undefined && (!Number.isSafeInteger(totalItems) || totalItems < 0))
        throw new Error('projected GitHub pagination received an invalid item count');
    const knownPageCount = totalItems !== undefined;
    const pageCount = Math.ceil(Math.min(totalItems ?? itemCeiling, itemCeiling) / pageSize);
    let consumedItems = 0;
    for (let page = 1; page <= pageCount; page += 1) {
        const separator = path.includes('?') ? '&' : '?';
        const value = await ghApi(`${path}${separator}per_page=${pageSize}&page=${page}`, { spawn, jq });
        if (!Array.isArray(value))
            throw new Error(`projected GitHub page ${page} must be a JSON array`);
        if (value.length > pageSize)
            throw new Error(`projected GitHub page ${page} exceeds ${pageSize} items`);
        const remaining = itemCeiling - consumedItems;
        const boundedPage = value.length > remaining ? value.slice(0, remaining) : value;
        await consume(boundedPage, page);
        consumedItems += boundedPage.length;
        if (consumedItems >= itemCeiling)
            break;
        if (!knownPageCount && value.length < pageSize)
            break;
    }
}
async function ghApiProjectedPages(path, options) {
    const items = [];
    await consumeGhApiProjectedPages(path, options, page => items.push(...page));
    return items;
}
export async function fetchAuthenticatedLogin({ spawn } = {}) {
    const viewer = record(await ghApi('user', { spawn }), 'authenticated user');
    const login = stringField(viewer.login);
    if (!isNonEmptyString(login, { max: 39 }))
        throw new Error('authenticated GitHub login is unavailable');
    return login;
}
export async function fetchIssue({ owner, repo, number }, { spawn } = {}) {
    if (!isSafeOwner(owner) || !isSafeRepo(repo) || !isPositiveInteger(number)) {
        throw new Error('invalid issue target');
    }
    const [issueRaw, commentsValue] = await Promise.all([
        ghApi(`repos/${owner}/${repo}/issues/${number}`, { spawn }),
        ghApi(`repos/${owner}/${repo}/issues/${number}/comments`, { spawn, paginate: true }),
    ]);
    const issue = record(issueRaw, 'issue response');
    const commentsRaw = normalizeFeedbackArray(commentsValue, 'issue comments response');
    const warnings = [];
    const comments = boundItems(commentsRaw.map(comment => ({
        id: comment.id,
        body: boundText(comment.body, MAX_BODY_LENGTH),
        author: comment.user?.login,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        url: comment.html_url,
    })), MAX_ITEMS, warnings);
    return {
        owner,
        repo,
        number,
        title: boundText(issue.title, MAX_BODY_LENGTH),
        body: boundText(issue.body, MAX_BODY_LENGTH),
        state: stringField(issue.state),
        url: stringField(issue.html_url),
        author: loginField(issue.user)?.login,
        comments,
        complete: commentsRaw.length <= MAX_ITEMS,
        warnings,
    };
}
export async function fetchPull({ owner, repo, number }, { spawn } = {}) {
    return normalizePullMetadata(await ghApi(`repos/${owner}/${repo}/pulls/${number}`, { spawn }));
}
function pullFileMetadataValid(file) {
    const filenameValid = isSafeRelativePath(file.filename);
    const previousValid = file.previous_filename === undefined || isSafeRelativePath(file.previous_filename);
    const renameValid = file.status !== 'renamed' || isSafeRelativePath(file.previous_filename);
    const counts = [file.additions, file.deletions, file.changes];
    const countsValid = counts.every(value => Number.isSafeInteger(value) && value >= 0)
        && file.changes === file.additions + file.deletions;
    return filenameValid && previousValid && renameValid && PULL_FILE_STATUSES.has(file.status)
        && is40HexSha(file.sha) && countsValid;
}
function assessPatch(file, totalBytesUsed) {
    const map = { left: new Set(), right: new Set(), hunks: [] };
    const safePath = isSafeRelativePath(file.filename)
        && (file.previous_filename === undefined || isSafeRelativePath(file.previous_filename));
    const immutableMetadataValid = pullFileMetadataValid(file);
    const patch = file.patch || '';
    const measuredPatchBytes = Buffer.byteLength(patch, 'utf-8');
    const patchBytes = file.patch_oversized === true && Number.isSafeInteger(file.patch_bytes)
        ? file.patch_bytes : measuredPatchBytes;
    const available = safePath && (patchBytes > 0 || file.patch_oversized === true);
    const perFileLimited = file.patch_oversized === true || patchBytes > MAX_PATCH_BYTES_PER_FILE;
    const aggregateLimited = totalBytesUsed + patchBytes > MAX_TOTAL_PATCH_BYTES;
    const retained = immutableMetadataValid && available && !perFileLimited && !aggregateLimited;
    let reason = !safePath ? 'redacted-path'
        : !immutableMetadataValid ? 'metadata-mismatch'
            : patchBytes === 0 ? 'missing-patch'
            : perFileLimited ? 'per-file-byte-limit'
                : aggregateLimited ? 'aggregate-byte-limit'
                    : 'malformed-patch';
    if (!retained) {
        return {
            available,
            patchBytes,
            patch: undefined,
            bytesUsed: 0,
            map,
            complete: false,
            evidence: {
                status: patchBytes === 0 || !safePath || !immutableMetadataValid ? 'unavailable' : 'limited',
                reason,
                retention: 'none',
                validation: { structural: false, metadata: false },
            },
        };
    }
    let current = null;
    let previousOldEnd = -1;
    let previousNewEnd = -1;
    let additions = 0;
    let deletions = 0;
    let valid = true;
    let visitedPatchLines = 0;
    let lineMapLimited = false;
    const addLine = (side, line) => {
        const set = map[side];
        if (set.has(line))
            return true;
        if (map.left.size + map.right.size >= MAX_LINE_MAP_ENTRIES_PER_FILE) {
            lineMapLimited = true;
            return false;
        }
        set.add(line);
        return true;
    };
    const finishHunk = () => {
        if (!current)
            return;
        if (current.oldConsumed !== current.oldCount || current.newConsumed !== current.newCount)
            valid = false;
        previousOldEnd = current.oldStart + current.oldCount;
        previousNewEnd = current.newStart + current.newCount;
    };
    let offset = 0;
    while (offset < patch.length) {
        const nextNewline = patch.indexOf('\n', offset);
        const line = patch.slice(offset, nextNewline === -1 ? patch.length : nextNewline);
        offset = nextNewline === -1 ? patch.length : nextNewline + 1;
        visitedPatchLines += 1;
        const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
        if (hunk) {
            finishHunk();
            const oldStart = Number.parseInt(hunk[1] ?? '', 10);
            const oldCount = hunk[2] === undefined ? 1 : Number.parseInt(hunk[2], 10);
            const newStart = Number.parseInt(hunk[3] ?? '', 10);
            const newCount = hunk[4] === undefined ? 1 : Number.parseInt(hunk[4], 10);
            if (!Number.isSafeInteger(oldStart) || !Number.isSafeInteger(newStart)
                || !Number.isSafeInteger(oldCount) || !Number.isSafeInteger(newCount)
                || (oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)
                || oldStart < previousOldEnd || newStart < previousNewEnd) {
                valid = false;
            }
            current = { oldStart, oldCount, newStart, newCount, oldConsumed: 0, newConsumed: 0 };
            if (map.hunks.length >= MAX_LINE_MAP_ENTRIES_PER_FILE) {
                lineMapLimited = true;
                break;
            }
            map.hunks.push({ oldStart, oldCount, newStart, newCount });
            continue;
        }
        if (!current) {
            valid = false;
            continue;
        }
        const oldLine = current.oldStart + current.oldConsumed;
        const newLine = current.newStart + current.newConsumed;
        if (line.startsWith('-')) {
            if (!addLine('left', oldLine))
                break;
            current.oldConsumed += 1;
            deletions += 1;
        }
        else if (line.startsWith('+')) {
            if (!addLine('right', newLine))
                break;
            current.newConsumed += 1;
            additions += 1;
        }
        else if (line === '\\ No newline at end of file') {
            // "\ No newline at end of file" — no line number advance.
        }
        else if (line.startsWith(' ')) {
            if (!addLine('left', oldLine) || !addLine('right', newLine))
                break;
            current.oldConsumed += 1;
            current.newConsumed += 1;
        }
        else
            valid = false;
        if (current.oldConsumed > current.oldCount || current.newConsumed > current.newCount)
            valid = false;
    }
    if (lineMapLimited) {
        return {
            available,
            patchBytes,
            patch: undefined,
            bytesUsed: 0,
            map: { left: new Set(), right: new Set(), hunks: [] },
            complete: false,
            visitedPatchLines,
            evidence: {
                status: 'limited',
                reason: 'per-file-line-map-limit',
                retention: 'none',
                validation: { structural: false, metadata: false },
            },
        };
    }
    finishHunk();
    if (map.hunks.length === 0)
        valid = false;
    const additionsMatch = file.additions === additions;
    const deletionsMatch = file.deletions === deletions;
    const changesMatch = file.changes === additions + deletions;
    const metadataValid = immutableMetadataValid && additionsMatch && deletionsMatch && changesMatch;
    const complete = valid && metadataValid;
    if (!valid)
        reason = 'malformed-patch';
    else if (!metadataValid)
        reason = 'metadata-mismatch';
    else
        reason = 'complete';
    return {
        available,
        patchBytes,
        patch,
        bytesUsed: patchBytes,
        map: complete ? map : { left: new Set(), right: new Set(), hunks: [] },
        complete,
        visitedPatchLines,
        evidence: {
            status: complete ? 'complete' : 'limited',
            reason,
            retention: 'full',
            validation: { structural: valid, metadata: metadataValid },
        },
    };
}
function summarizeFile(file, totalBytesUsed) {
    const safePath = isSafeRelativePath(file.filename)
        && (file.previous_filename === undefined || isSafeRelativePath(file.previous_filename));
    const assessment = assessPatch(file, totalBytesUsed);
    const lineMap = assessment.map;
    const summary = {
        filename: file.filename,
        previousFilename: normalizedPreviousPath(file),
        status: file.status,
        sha: file.sha,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patchAvailable: assessment.available,
        patchTruncated: !assessment.complete,
        patchRedacted: !safePath,
        patchBytes: assessment.patchBytes,
        lineMap: {
            left: [...lineMap.left].sort((a, b) => a - b),
            right: [...lineMap.right].sort((a, b) => a - b),
            hunks: lineMap.hunks,
        },
        patch: assessment.patch,
        patchEvidence: assessment.evidence,
        bytesUsed: assessment.bytesUsed,
    };
    summary[SUMMARY_PATCH_VISITED_LINES] = assessment.visitedPatchLines ?? 0;
    return summary;
}
function normalizeReview(review) {
    return {
        id: review.id,
        state: review.state,
        commitId: review.commit_id,
        body: boundText(review.body, MAX_BODY_LENGTH),
        author: review.user?.login,
        submittedAt: review.submitted_at,
        url: review.html_url,
    };
}
function normalizeComment(comment) {
    return {
        id: comment.id,
        body: boundText(comment.body, MAX_BODY_LENGTH),
        author: comment.user?.login,
        path: comment.path,
        line: comment.line,
        side: comment.side,
        commitId: comment.commit_id,
        updatedAt: comment.updated_at,
        url: comment.html_url,
    };
}
export async function pullSnapshot({ owner, repo, number }, { spawn } = {}) {
    if (!isSafeOwner(owner) || !isSafeRepo(repo) || !isPositiveInteger(number)) {
        throw new Error('invalid pull request target');
    }
    const warnings = [];
    let changedDuringAcquisition = false;
    let acquired;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const startMeta = await fetchPull({ owner, repo, number }, { spawn });
        const startHead = startMeta.head?.sha;
        const startBase = startMeta.base?.sha;
        if (!is40HexSha(startHead) || !is40HexSha(startBase)) {
            throw new Error('PR metadata missing valid base/head SHA');
        }
        const [filesValue, reviewsValue, reviewCommentsValue, issueCommentsValue] = await Promise.all([
            ghApi(`repos/${owner}/${repo}/pulls/${number}/files`, { spawn, paginate: true }),
            ghApi(`repos/${owner}/${repo}/pulls/${number}/reviews`, { spawn, paginate: true }),
            ghApi(`repos/${owner}/${repo}/pulls/${number}/comments`, { spawn, paginate: true }),
            ghApi(`repos/${owner}/${repo}/issues/${number}/comments`, { spawn, paginate: true }),
        ]);
        const files = normalizeFileArray(filesValue);
        const reviews = normalizeFeedbackArray(reviewsValue, 'reviews response');
        const reviewComments = normalizeFeedbackArray(reviewCommentsValue, 'review comments response');
        const issueComments = normalizeFeedbackArray(issueCommentsValue, 'issue comments response');
        const endMeta = await fetchPull({ owner, repo, number }, { spawn });
        const coherent = endMeta.head?.sha === startHead && endMeta.base?.sha === startBase;
        if (coherent) {
            acquired = { meta: endMeta, files, reviews, reviewComments, issueComments };
            break;
        }
        changedDuringAcquisition = true;
        if (attempt === 0)
            warnings.push('PR head changed during snapshot acquisition; retried once');
    }
    if (!acquired) {
        throw new Error('PR head changed during both snapshot attempts');
    }
    const { meta } = acquired;
    const allFiles = acquired.files;
    const fetchedFiles = allFiles.length;
    const totalChangedFiles = meta.changed_files ?? fetchedFiles;
    if (totalChangedFiles > MAX_CHANGED_FILES || fetchedFiles !== totalChangedFiles) {
        warnings.push(`changed files exceed or did not satisfy the ${MAX_CHANGED_FILES} file API limit`);
    }
    const files = allFiles.slice(0, MAX_CHANGED_FILES);
    const fileMetadataComplete = files.every(pullFileMetadataValid);
    if (!fileMetadataComplete)
        warnings.push('one or more changed files have invalid immutable metadata');
    const feedbackWasCapped = acquired.reviews.length > MAX_ITEMS
        || acquired.reviewComments.length > MAX_ITEMS
        || acquired.issueComments.length > MAX_ITEMS;
    const feedbackBodyWasTruncated = [
        ...acquired.reviews,
        ...acquired.reviewComments,
        ...acquired.issueComments,
    ].some(item => typeof item.body === 'string' && item.body.length > MAX_BODY_LENGTH);
    if (feedbackBodyWasTruncated)
        warnings.push('one or more feedback bodies were truncated');
    const pullBodyWasTruncated = [meta.title, meta.body]
        .some(item => typeof item === 'string' && item.length > MAX_BODY_LENGTH);
    if (pullBodyWasTruncated)
        warnings.push('pull request title or body was truncated');
    const reviews = boundItems(acquired.reviews.map(normalizeReview), MAX_ITEMS, warnings);
    const reviewComments = boundItems(acquired.reviewComments.map(normalizeComment), MAX_ITEMS, warnings);
    const issueComments = boundItems(acquired.issueComments.map(normalizeComment), MAX_ITEMS, warnings);
    let totalPatchBytes = 0;
    const fileSummaries = files.map(file => {
        const summary = summarizeFile(file, totalPatchBytes);
        totalPatchBytes += summary.bytesUsed;
        return summary;
    });
    if (fileSummaries.some(file => file.patchRedacted))
        warnings.push('one or more secret-like paths were redacted');
    if (fileSummaries.some(file => file.patchTruncated))
        warnings.push('one or more file patches were unavailable or truncated');
    const feedbackDigest = digestSnapshot(meta, files, acquired.reviews, acquired.reviewComments, acquired.issueComments);
    const pullContentDigest = hashString(JSON.stringify({
        title: hashString(typeof meta.title === 'string' ? meta.title : ''),
        body: hashString(typeof meta.body === 'string' ? meta.body : ''),
    }));
    const headSha = meta.head?.sha;
    const baseSha = meta.base?.sha;
    if (!is40HexSha(headSha) || !is40HexSha(baseSha))
        throw new Error('PR metadata missing valid base/head SHA');
    const canonicalOwner = meta.base?.repo?.owner?.login ?? owner;
    const canonicalRepo = meta.base?.repo?.name ?? repo;
    if (!isSafeOwner(canonicalOwner) || !isSafeRepo(canonicalRepo)) {
        throw new Error('PR metadata returned an invalid canonical repository identity');
    }
    const allFilesIncluded = fileMetadataComplete
        && totalChangedFiles <= MAX_CHANGED_FILES && fetchedFiles === totalChangedFiles;
    const patchesComplete = !fileSummaries.some(file => file.patchTruncated || file.patchRedacted);
    const inventoryComplete = allFilesIncluded;
    const feedbackComplete = !feedbackWasCapped && !feedbackBodyWasTruncated;
    const hasRedactedPath = fileSummaries.some(file => file.patchRedacted);
    const integrityComplete = inventoryComplete && feedbackComplete && !pullBodyWasTruncated && !hasRedactedPath;
    const reviewabilityStatus = !integrityComplete ? 'unpostable' : patchesComplete ? 'complete' : 'limited-comment';
    const limitations = [];
    if (!inventoryComplete)
        limitations.push(fileMetadataComplete
            ? 'changed file inventory is incomplete'
            : 'changed file inventory contains invalid immutable metadata');
    if (feedbackWasCapped)
        limitations.push('review feedback inventory is capped');
    if (feedbackBodyWasTruncated)
        limitations.push('one or more feedback bodies were truncated');
    if (pullBodyWasTruncated)
        limitations.push('pull request title or body was truncated');
    if (hasRedactedPath)
        limitations.push('one or more changed paths are redacted and cannot be represented safely');
    for (const file of fileSummaries) {
        if (file.patchEvidence.status !== 'complete' && limitations.length < MAX_REVIEWABILITY_LIMITATIONS) {
            const label = file.patchRedacted ? 'redacted file' : file.filename.slice(0, 256);
            limitations.push(`${label}: patch evidence ${file.patchEvidence.reason}`);
        }
    }
    const complete = reviewabilityStatus === 'complete';
    const contentTruncated = !complete;
    const evidenceSummary = {
        total: fileSummaries.length,
        complete: fileSummaries.filter(file => file.patchEvidence.status === 'complete').length,
        limited: fileSummaries.filter(file => file.patchEvidence.status !== 'complete').length,
        reasons: Object.fromEntries([...new Set(fileSummaries
            .filter(file => file.patchEvidence.status !== 'complete')
            .map(file => file.patchEvidence.reason))].sort().map(reason => [
            reason,
            fileSummaries.filter(file => file.patchEvidence.reason === reason).length,
        ])),
    };
    // Unified-diff recovery is deliberately unavailable: safely associating arbitrary
    // diff sections with renamed/binary paths needs a substantially larger parser. The
    // caller receives a structured limited state instead of guessed evidence.
    const recovery = {
        status: evidenceSummary.limited === 0 ? 'not-needed' : 'unavailable',
        attempted: false,
        recovered: 0,
        unavailable: evidenceSummary.limited,
        reason: evidenceSummary.limited === 0 ? undefined : 'safe-unified-diff-recovery-not-implemented',
    };
    const evidenceDigest = digestEvidence(headSha, baseSha, fileSummaries);
    return {
        owner: canonicalOwner,
        repo: canonicalRepo,
        number,
        pull: {
            title: boundText(meta.title, MAX_BODY_LENGTH),
            body: boundText(meta.body, MAX_BODY_LENGTH),
            state: meta.state,
            draft: meta.draft,
            url: meta.html_url,
            author: meta.user?.login,
            baseRef: meta.base?.ref,
            headRef: meta.head?.ref,
            contentDigest: pullContentDigest,
        },
        snapshotId: snapshotId(canonicalOwner, canonicalRepo, number, headSha, baseSha, files),
        headSha,
        baseSha,
        headChangedDuringAcquisition: changedDuringAcquisition,
        changedFiles: totalChangedFiles,
        fetchedFiles,
        filesCapped: !allFilesIncluded,
        files: fileSummaries,
        reviews,
        reviewComments,
        issueComments,
        feedbackDigest,
        evidenceDigest,
        evidenceSummary,
        recovery,
        complete,
        contentTruncated,
        reviewability: {
            status: reviewabilityStatus,
            inventoryComplete,
            feedbackComplete,
            patchesComplete,
            limitations: limitations.slice(0, MAX_REVIEWABILITY_LIMITATIONS),
        },
        completeness: {
            headCoherent: true,
            allFilesIncluded,
            feedbackComplete,
            patchesComplete,
            patchesMayBeTruncated: !patchesComplete,
        },
        warnings,
    };
}

function validatePullTarget({ owner, repo, number }) {
    if (!isSafeOwner(owner) || !isSafeRepo(repo) || !isPositiveInteger(number))
        throw new Error('invalid pull request target');
}
function isValidChangedFileCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

async function compactPullAcquisition({ owner, repo, number }, { spawn } = {}) {
    validatePullTarget({ owner, repo, number });
    const warnings = [];
    let acquired;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const startMeta = await fetchPull({ owner, repo, number }, { spawn });
        const startHead = startMeta.head?.sha;
        const startBase = startMeta.base?.sha;
        if (!is40HexSha(startHead) || !is40HexSha(startBase))
            throw new Error('PR metadata missing valid base/head SHA');
        const [filesValue, reviewsValue, reviewCommentsValue, issueCommentsValue] = await Promise.all([
            ghApiProjectedPages(`repos/${owner}/${repo}/pulls/${number}/files`, {
                spawn, jq: COMPACT_FILES_JQ,
                totalItems: isValidChangedFileCount(startMeta.changed_files) ? startMeta.changed_files : undefined,
                itemCeiling: MAX_CHANGED_FILES,
            }),
            ghApiProjectedPages(`repos/${owner}/${repo}/pulls/${number}/reviews`, {
                spawn, jq: COMPACT_FEEDBACK_JQ, itemCeiling: MAX_ITEMS + 1,
            }),
            ghApiProjectedPages(`repos/${owner}/${repo}/pulls/${number}/comments`, {
                spawn, jq: COMPACT_FEEDBACK_JQ, itemCeiling: MAX_ITEMS + 1,
            }),
            ghApiProjectedPages(`repos/${owner}/${repo}/issues/${number}/comments`, {
                spawn, jq: COMPACT_FEEDBACK_JQ, itemCeiling: MAX_ITEMS + 1,
            }),
        ]);
        const files = normalizeFileArray(filesValue);
        const reviews = normalizeFeedbackArray(reviewsValue, 'reviews response');
        const reviewComments = normalizeFeedbackArray(reviewCommentsValue, 'review comments response');
        const issueComments = normalizeFeedbackArray(issueCommentsValue, 'issue comments response');
        const endMeta = await fetchPull({ owner, repo, number }, { spawn });
        if (endMeta.head?.sha === startHead && endMeta.base?.sha === startBase) {
            const inventoryMetadataValid = isValidChangedFileCount(startMeta.changed_files)
                && isValidChangedFileCount(endMeta.changed_files)
                && startMeta.changed_files === endMeta.changed_files;
            acquired = { meta: endMeta, files, reviews, reviewComments, issueComments, inventoryMetadataValid };
            break;
        }
        if (attempt === 0)
            warnings.push('PR head changed during compact manifest acquisition; retried once');
    }
    if (!acquired)
        throw new Error('PR head changed during both compact manifest attempts');
    const { meta, files, reviews, reviewComments, issueComments, inventoryMetadataValid } = acquired;
    const headSha = meta.head?.sha;
    const baseSha = meta.base?.sha;
    const canonicalOwner = meta.base?.repo?.owner?.login ?? owner;
    const canonicalRepo = meta.base?.repo?.name ?? repo;
    if (!is40HexSha(headSha) || !is40HexSha(baseSha))
        throw new Error('PR metadata missing valid base/head SHA');
    if (!isSafeOwner(canonicalOwner) || !isSafeRepo(canonicalRepo))
        throw new Error('PR metadata returned an invalid canonical repository identity');
    const totalChangedFiles = inventoryMetadataValid ? meta.changed_files : undefined;
    const fileMetadataComplete = files.every(pullFileMetadataValid);
    const inventoryComplete = inventoryMetadataValid && fileMetadataComplete
        && totalChangedFiles <= MAX_CHANGED_FILES && files.length === totalChangedFiles;
    const feedbackComplete = reviews.length <= MAX_ITEMS && reviewComments.length <= MAX_ITEMS && issueComments.length <= MAX_ITEMS;
    const pathsSafe = files.every(file => isSafeRelativePath(file.filename)
        && (file.previous_filename === undefined || isSafeRelativePath(file.previous_filename)));
    if (!inventoryMetadataValid)
        warnings.push('changed file count metadata is missing, invalid, or changed; inventory integrity is unknown');
    else if (!fileMetadataComplete)
        warnings.push('one or more changed files have invalid immutable metadata');
    else if (!inventoryComplete)
        warnings.push('changed file inventory is incomplete');
    if (!feedbackComplete)
        warnings.push('review feedback inventory is capped');
    if (!pathsSafe)
        warnings.push('one or more changed paths are redacted and cannot be represented safely');
    return {
        owner: canonicalOwner,
        repo: canonicalRepo,
        number,
        snapshotId: snapshotId(canonicalOwner, canonicalRepo, number, headSha, baseSha, files),
        baseSha,
        headSha,
        feedbackDigest: digestSnapshot(meta, files, reviews, reviewComments, issueComments),
        evidenceDigest: digestEvidence(headSha, baseSha, files),
        changedFiles: totalChangedFiles,
        fetchedFiles: files.length,
        files,
        inventoryComplete,
        feedbackComplete,
        pathsSafe,
        feedback: { reviews, 'review-comments': reviewComments, 'issue-comments': issueComments },
        pull: {
            state: meta.state,
            draft: meta.draft,
            author: meta.user?.login,
            contentDigest: hashString(JSON.stringify({ title: hashString(meta.title ?? ''), body: hashString(meta.body ?? '') })),
        },
        warnings,
    };
}

export async function pullManifest(target, { spawn } = {}) {
    const compact = await compactPullAcquisition(target, { spawn });
    return {
        owner: compact.owner,
        repo: compact.repo,
        number: compact.number,
        snapshotId: compact.snapshotId,
        baseSha: compact.baseSha,
        headSha: compact.headSha,
        feedbackDigest: compact.feedbackDigest,
        evidenceDigest: compact.evidenceDigest,
        changedFiles: compact.changedFiles,
        fetchedFiles: compact.fetchedFiles,
        files: compact.files.map(file => ({
            path: file.filename,
            previousPath: normalizedPreviousPath(file),
            status: file.status,
            sha: file.sha,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
        })),
        reviewability: {
            status: compact.inventoryComplete && compact.feedbackComplete && compact.pathsSafe ? 'manifest' : 'unpostable',
            inventoryComplete: compact.inventoryComplete,
            feedbackComplete: compact.feedbackComplete,
            patchesComplete: false,
            limitations: compact.warnings,
        },
        evidenceSummary: {
            total: compact.files.length,
            acquired: 0,
            complete: 0,
            limited: 0,
            unknown: compact.files.length,
        },
        recovery: { status: 'not-attempted', attempted: false, recovered: 0, unavailable: 0 },
        pull: compact.pull,
        feedback: Object.fromEntries(Object.entries(compact.feedback).map(([kind, items]) => [kind, {
            items: items.length,
            pages: Math.ceil(items.length / FEEDBACK_PAGE_SIZE),
        }])),
        warnings: compact.warnings,
    };
}

function selectedEvidenceFilesJq(paths) {
    // JSON.stringify is the only interpolation: validated paths become a JSON value,
    // never jq syntax. The filter shape and projected fields are fixed internally.
    const encodedPaths = JSON.stringify(paths);
    return `map(select(.filename as $filename | ${encodedPaths} | index($filename)) | ${EVIDENCE_FILE_JQ})`;
}

const SUMMARY_PATCH_HASH = Symbol('summaryPatchHash');
const SUMMARY_PATCH_VISITED_LINES = Symbol('summaryPatchVisitedLines');
const SUMMARY_LINE_MAP_ENTRIES = Symbol('summaryLineMapEntries');
function batchDigestForSummaries(identity, paths, files) {
    return hashString(JSON.stringify({
        ...identityFields(identity),
        paths,
        files: files.map(file => ({
            filename: file.filename,
            previousFilename: normalizedPreviousPath(file),
            status: file.status,
            sha: file.sha,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patchHash: file[SUMMARY_PATCH_HASH] ?? (typeof file.patch === 'string' ? hashString(file.patch) : null),
            patchEvidence: file.patchEvidence,
            lineMap: file.lineMap,
        })),
    }));
}

function precomputeEvidenceSummary(raw, retainPatch) {
    const summary = summarizeFile(raw, 0);
    summary[SUMMARY_PATCH_HASH] = typeof summary.patch === 'string' ? hashString(summary.patch) : null;
    summary[SUMMARY_LINE_MAP_ENTRIES] = lineMapEntryCount(summary);
    summary.lineMap = { left: summary.lineMap.left, right: summary.lineMap.right, hunks: [] };
    if (!retainPatch)
        summary.patch = undefined;
    return summary;
}

function limitedSummary(summary, reason) {
    const limited = {
        ...summary,
        patchTruncated: true,
        lineMap: { left: [], right: [], hunks: [] },
        patch: undefined,
        patchEvidence: {
            status: 'limited',
            reason,
            retention: 'none',
            validation: { structural: false, metadata: false },
        },
        bytesUsed: 0,
    };
    limited[SUMMARY_PATCH_HASH] = null;
    limited[SUMMARY_LINE_MAP_ENTRIES] = 0;
    return limited;
}

function lineMapEntryCount(summary) {
    return summary[SUMMARY_LINE_MAP_ENTRIES]
        ?? summary.lineMap.left.length + summary.lineMap.right.length;
}

function applyBatchEvidenceLimits(summaries) {
    let totalPatchBytes = 0;
    let totalLineMapEntries = 0;
    return summaries.map(precomputed => {
        let summary = precomputed;
        if (precomputed.bytesUsed > 0 && totalPatchBytes + precomputed.bytesUsed > MAX_TOTAL_PATCH_BYTES)
            summary = limitedSummary(precomputed, 'aggregate-byte-limit');
        else {
            const lineEntries = lineMapEntryCount(precomputed);
            if (lineEntries > 0 && totalLineMapEntries + lineEntries > MAX_LINE_MAP_ENTRIES_PER_BATCH)
                summary = limitedSummary(precomputed, 'batch-line-map-limit');
        }
        totalPatchBytes += summary.bytesUsed;
        totalLineMapEntries += lineMapEntryCount(summary);
        return summary;
    });
}

export function digestRawFileBatch(identity, paths, rawFiles) {
    const summaries = applyBatchEvidenceLimits(rawFiles.map(file => precomputeEvidenceSummary(file, true)));
    return batchDigestForSummaries(identity, paths, paths.map(path => summaries.find(file => file.filename === path)));
}

function boundedManifestFiles(manifest) {
    const complete = manifest.inventoryComplete === true || manifest.reviewability?.inventoryComplete === true;
    if (!complete || !Array.isArray(manifest.files) || manifest.files.length > MAX_CHANGED_FILES)
        throw new Error('file evidence requires a complete bounded manifest');
    return manifest.files.map(file => ({
        path: file.path ?? file.filename,
        previousPath: normalizedPreviousPath(file),
        status: file.status,
        sha: file.sha,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
    }));
}

function validateEvidenceMetadata(expected, raw) {
    if (normalizedPreviousPath(raw) !== normalizedPreviousPath(expected) || raw.status !== expected.status
        || raw.sha !== expected.sha || raw.additions !== expected.additions
        || raw.deletions !== expected.deletions || raw.changes !== expected.changes)
        throw new Error(`projected evidence metadata changed for path: ${raw.filename}`);
}

async function acquireManifestEvidence(manifest, paths, { spawn, retainPatches = false, onEvidencePage } = {}) {
    const manifestFiles = boundedManifestFiles(manifest);
    const expectedByPath = new Map(manifestFiles.map(file => [file.path, file]));
    const selected = paths === undefined ? undefined : new Set(paths);
    const summariesByPath = new Map();
    let manifestIndex = 0;
    let retainedPatchBytes = 0;
    let retainedLineMapEntries = 0;
    let retainedLineMapHunkObjects = 0;
    await consumeGhApiProjectedPages(`repos/${manifest.owner}/${manifest.repo}/pulls/${manifest.number}/files`, {
        spawn,
        jq: paths === undefined ? EVIDENCE_FILES_JQ : selectedEvidenceFilesJq(paths),
        totalItems: manifestFiles.length,
        itemCeiling: MAX_CHANGED_FILES,
        pageSize: EVIDENCE_FILE_PAGE_SIZE,
    }, async (projectedPage, page) => {
        const inFlightBase64Bytes = projectedPage.reduce((total, item) => total
            + (typeof item?.patch_base64 === 'string' ? Buffer.byteLength(item.patch_base64, 'utf8') : 0), 0);
        const rawFiles = normalizeEvidenceFileArray(projectedPage);
        let inFlightPatchBytes = 0;
        for (const raw of rawFiles) {
            const expected = expectedByPath.get(raw.filename);
            if (!expected || (selected && !selected.has(raw.filename)))
                throw new Error('projected evidence response contained an unrelated path');
            if (paths === undefined && raw.filename !== manifestFiles[manifestIndex].path)
                throw new Error('projected evidence response changed manifest path order');
            if (summariesByPath.has(raw.filename))
                throw new Error(`projected evidence response duplicated path: ${raw.filename}`);
            validateEvidenceMetadata(expected, raw);
            inFlightPatchBytes += typeof raw.patch === 'string' ? Buffer.byteLength(raw.patch, 'utf8') : 0;
            const summary = precomputeEvidenceSummary(raw, retainPatches);
            retainedPatchBytes += typeof summary.patch === 'string' ? Buffer.byteLength(summary.patch, 'utf8') : 0;
            retainedLineMapEntries += summary.lineMap.left.length + summary.lineMap.right.length;
            retainedLineMapHunkObjects += summary.lineMap.hunks.length;
            summariesByPath.set(raw.filename, summary);
            manifestIndex += 1;
        }
        if (onEvidencePage)
            await onEvidencePage({
                page,
                files: rawFiles.length,
                inFlightPatchBytes,
                inFlightBase64Bytes,
                retainedPatchBytes,
                retainedBase64Bytes: 0,
                retainedLineMapEntries,
                retainedLineMapHunkObjects,
                visitedPatchLines: rawFiles.reduce((total, file) => total
                    + (summariesByPath.get(file.filename)?.[SUMMARY_PATCH_VISITED_LINES] ?? 0), 0),
            });
    });
    if (paths === undefined && summariesByPath.size !== manifestFiles.length)
        throw new Error('projected evidence response did not match the manifest file count');
    if (paths !== undefined) {
        const missing = paths.filter(path => !summariesByPath.has(path));
        if (missing.length)
            throw new Error(`projected evidence response omitted requested paths: ${missing.join(', ')}`);
    }
    return summariesByPath;
}

function assembleEvidenceBatches(identity, declarations, summariesByPath) {
    return declarations.map((declaration, index) => {
        if (!declaration || !Array.isArray(declaration.paths) || declaration.paths.length < 1
            || declaration.paths.length > MAX_PULL_FILE_BATCH
            || new Set(declaration.paths).size !== declaration.paths.length)
            throw new Error(`file batch ${index} has invalid paths`);
        const files = applyBatchEvidenceLimits(declaration.paths.map(path => {
            const precomputed = summariesByPath.get(path);
            if (!precomputed)
                throw new Error(`file batch ${index} contains a non-manifest path`);
            return precomputed;
        }));
        return {
            paths: [...declaration.paths],
            batchDigest: batchDigestForSummaries(identity, declaration.paths, files),
            files,
        };
    });
}

export async function pullFileBatchesAtManifest(manifest, declarations, { spawn, onEvidencePage } = {}) {
    validatePullTarget(manifest);
    if (!Array.isArray(declarations))
        throw new Error('internal file batch declarations must be an array');
    const identity = identityFields(manifest);
    if (!is40HexSha(identity.baseSha) || !is40HexSha(identity.headSha)
        || typeof identity.snapshotId !== 'string' || typeof identity.feedbackDigest !== 'string'
        || typeof identity.evidenceDigest !== 'string')
        throw new Error('internal file evidence manifest identity is invalid');
    const summariesByPath = await acquireManifestEvidence(manifest, undefined, { spawn, onEvidencePage });
    const batches = assembleEvidenceBatches(identity, declarations, summariesByPath);
    return { ...identity, batches };
}

export async function pullFilesAtHead({ owner, repo, number, baseSha, headSha, snapshotId: expectedSnapshotId, feedbackDigest, evidenceDigest, paths }, { spawn, onEvidencePage } = {}) {
    validatePullTarget({ owner, repo, number });
    if (!is40HexSha(baseSha))
        throw new Error('baseSha must be a 40-char hex SHA');
    if (!is40HexSha(headSha))
        throw new Error('headSha must be a 40-char hex SHA');
    if (typeof expectedSnapshotId !== 'string' || !/^naru-snap-[0-9a-f]{64}$/.test(expectedSnapshotId))
        throw new Error('snapshotId is invalid');
    if (typeof feedbackDigest !== 'string' || !/^[0-9a-f]{64}$/.test(feedbackDigest)
        || typeof evidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceDigest))
        throw new Error('manifest digests are invalid');
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PULL_FILE_BATCH)
        throw new Error(`paths must contain 1-${MAX_PULL_FILE_BATCH} items`);
    const seen = new Set();
    for (const path of paths) {
        if (!isSafeRelativePath(path))
            throw new Error('paths must contain only safe relative paths');
        if (seen.has(path))
            throw new Error(`duplicate path: ${path}`);
        seen.add(path);
    }
    const expectedIdentity = { owner, repo, number, baseSha, headSha, snapshotId: expectedSnapshotId, feedbackDigest, evidenceDigest };
    const compact = await compactPullAcquisition({ owner, repo, number }, { spawn });
    assertManifestIdentity(expectedIdentity, compact, 'file batch manifest');
    if (!compact.inventoryComplete)
        throw new Error('cannot retrieve a file batch from an incomplete manifest inventory');
    const inventory = new Map(compact.files.map(file => [file.filename, file]));
    const unknown = paths.filter(path => !inventory.has(path));
    if (unknown.length)
        throw new Error(`paths are not members of the final snapshot: ${unknown.join(', ')}`);
    const selectedByPath = await acquireManifestEvidence(compact, paths, { spawn, retainPatches: true, onEvidencePage });
    const endMeta = await fetchPull({ owner, repo, number }, { spawn });
    if (endMeta.head?.sha !== compact.headSha || endMeta.base?.sha !== compact.baseSha)
        throw new Error('pull request head drifted during file batch acquisition');
    const assembled = assembleEvidenceBatches(compact, [{ paths }], selectedByPath)[0];
    const finalCompact = await compactPullAcquisition({ owner, repo, number }, { spawn });
    assertManifestIdentity(expectedIdentity, finalCompact, 'final file batch manifest');
    return {
        owner: compact.owner,
        repo: compact.repo,
        number: compact.number,
        snapshotId: compact.snapshotId,
        baseSha: compact.baseSha,
        headSha: compact.headSha,
        feedbackDigest: compact.feedbackDigest,
        evidenceDigest: compact.evidenceDigest,
        batchDigest: assembled.batchDigest,
        files: assembled.files,
    };
}

function feedbackMetadataDigest(items) {
    return hashString(JSON.stringify(items.map(item => ({
        id: item.id,
        state: item.state,
        commitId: item.commit_id ?? item.commitId,
        path: item.path,
        line: item.line,
        side: item.side,
        createdAt: item.created_at ?? item.createdAt,
        updatedAt: item.updated_at ?? item.submitted_at ?? item.updatedAt ?? item.submittedAt,
    }))));
}

export async function pullFeedbackPage({ owner, repo, number, baseSha, headSha, snapshotId: expectedSnapshotId, feedbackDigest, evidenceDigest, kind, page }, { spawn } = {}) {
    validatePullTarget({ owner, repo, number });
    if (!is40HexSha(baseSha) || !is40HexSha(headSha))
        throw new Error('baseSha and headSha must be 40-char hex SHAs');
    if (typeof expectedSnapshotId !== 'string' || !/^naru-snap-[0-9a-f]{64}$/.test(expectedSnapshotId)
        || typeof feedbackDigest !== 'string' || !/^[0-9a-f]{64}$/.test(feedbackDigest)
        || typeof evidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(evidenceDigest))
        throw new Error('manifest identity is invalid');
    if (!Object.hasOwn(FEEDBACK_KINDS, kind))
        throw new Error('feedback kind is invalid');
    if (!isPositiveInteger(page))
        throw new Error('feedback page must be a positive integer');
    const expectedIdentity = { owner, repo, number, baseSha, headSha, snapshotId: expectedSnapshotId, feedbackDigest, evidenceDigest };
    const compact = await compactPullAcquisition({ owner, repo, number }, { spawn });
    assertManifestIdentity(expectedIdentity, compact, 'feedback page manifest');
    const metadata = compact.feedback[kind];
    const pages = Math.ceil(metadata.length / FEEDBACK_PAGE_SIZE);
    if (page > pages || pages === 0)
        throw new Error('feedback page is not advertised by the manifest');
    const path = `${FEEDBACK_KINDS[kind]({ owner, repo, number })}?per_page=${FEEDBACK_PAGE_SIZE}&page=${page}`;
    const raw = await ghApi(path, { spawn, jq: BOUNDED_FEEDBACK_JQ });
    const items = normalizeFeedbackArray(raw, 'feedback page response');
    if (items.length > FEEDBACK_PAGE_SIZE)
        throw new Error('feedback page exceeds the fixed page size');
    if (items.some(item => typeof item.body === 'string' && item.body.length > MAX_BODY_LENGTH))
        throw new Error('feedback page contains an oversized body and is incomplete');
    const expectedMetadata = metadata.slice((page - 1) * FEEDBACK_PAGE_SIZE, page * FEEDBACK_PAGE_SIZE);
    if (feedbackMetadataDigest(items) !== feedbackMetadataDigest(expectedMetadata))
        throw new Error('feedback page metadata digest mismatch');
    const finalCompact = await compactPullAcquisition({ owner, repo, number }, { spawn });
    assertManifestIdentity(expectedIdentity, finalCompact, 'final feedback page manifest');
    const normalized = items.map(item => ({
        id: item.id,
        state: item.state,
        commitId: item.commit_id,
        body: boundText(item.body, MAX_BODY_LENGTH),
        author: item.user?.login,
        path: item.path,
        line: item.line,
        side: item.side,
        updatedAt: item.updated_at ?? item.submitted_at,
        url: item.html_url ?? item.url,
    }));
    const pageDigest = digestFeedbackPage(compact, kind, page, normalized);
    return { ...identityFields(compact), kind, page, pages, items: normalized, pageDigest };
}

export function digestFeedbackPage(identity, kind, page, normalizedItems) {
    return hashString(JSON.stringify({ ...identityFields(identity), kind, page, items: normalizedItems }));
}
export async function fetchSourceAtSha({ owner, repo, sha, path }, { spawn } = {}) {
    if (!isSafeOwner(owner) || !isSafeRepo(repo))
        throw new Error('invalid source target');
    if (!is40HexSha(sha))
        throw new Error('sha must be a 40-char hex SHA');
    if (!isSafeRelativePath(path))
        throw new Error('path must be a safe relative path');
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const result = await run(['gh', 'api', '--method', 'GET', `repos/${owner}/${repo}/contents/${encodedPath}?ref=${sha}`], { spawn, maxBytes: MAX_GH_BYTES });
    if (result.stdoutTruncated)
        throw new Error('bounded GitHub source response was truncated');
    if (!result.ok) {
        throw new Error(stripSecrets(result.stderr || result.stdout || 'source fetch failed'));
    }
    let parsed;
    try {
        parsed = JSON.parse(result.stdout);
    }
    catch {
        throw new Error('non-JSON source response');
    }
    const data = record(parsed, 'source response');
    const encoding = stringField(data.encoding);
    const encodedContent = stringField(data.content);
    if (encoding === 'base64' && encodedContent !== undefined) {
        const decoded = Buffer.from(encodedContent.replace(/\s/g, ''), 'base64').toString('utf-8');
        const contentTruncated = Buffer.byteLength(decoded, 'utf-8') > MAX_SOURCE_BYTES;
        return {
            owner,
            repo,
            sha,
            path,
            name: stringField(data.name),
            size: numberField(data.size),
            content: contentTruncated ? decoded.slice(0, MAX_SOURCE_BYTES) : decoded,
            contentTruncated,
        };
    }
    return {
        owner,
        repo,
        sha,
        path,
        name: stringField(data.name),
        size: numberField(data.size),
        content: null,
        message: stringField(data.message),
    };
}
