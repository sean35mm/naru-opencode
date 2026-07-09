// Read-only GitHub operations for naru-github-read. All gh calls use fixed argv
// with `gh api --method GET`. No arbitrary endpoints, methods, headers, or tokens.

import { run } from './transport.mjs';
import { createHash } from 'node:crypto';
import {
  isSafeOwner,
  isSafeRepo,
  isPositiveInteger,
  is40HexSha,
  isSafeRelativePath,
  isNonEmptyString,
  stripSecrets,
} from './validate.mjs';

const MAX_GH_BYTES = 32 * 1024 * 1024;
const MAX_CHANGED_FILES = 3000;
const MAX_BODY_LENGTH = 64 * 1024;
const MAX_ITEMS = 1000;
const MAX_PATCH_BYTES_PER_FILE = 1024 * 1024;
const MAX_TOTAL_PATCH_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;

export function hashString(s) {
  return createHash('sha256').update(s).digest('hex');
}

function fileDigest(files) {
  return hashString(JSON.stringify(files.map((file) => ({
    filename: file.filename,
    status: file.status,
    sha: file.sha,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  })).sort((a, b) => a.filename.localeCompare(b.filename))));
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
  const normalize = (items) => items.map((item) => ({
    id: item.id,
    state: item.state,
    commitId: item.commit_id ?? item.commitId,
    path: item.path,
    line: item.line,
    side: item.side,
    updatedAt: item.updated_at ?? item.submitted_at ?? item.updatedAt,
    body: hashString(typeof item.body === 'string' ? item.body : ''),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return hashString(JSON.stringify({
    headSha: meta.head?.sha || '',
    baseSha: meta.base?.sha || '',
    files: fileDigest(files),
    reviews: normalize(reviews),
    reviewComments: normalize(reviewComments),
    issueComments: normalize(issueComments),
  }));
}

function boundText(v, max) {
  if (typeof v !== 'string') return '';
  if (v.length <= max) return v;
  return v.slice(0, max) + '\n…[truncated]';
}

function boundItems(arr, max, warnings) {
  if (arr.length <= max) return arr;
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
    } catch {
      throw new Error('invalid GitHub URL');
    }
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash) {
      throw new Error('URL must be an https://github.com issue or pull request URL');
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 4 || (parts[2] !== 'pull' && parts[2] !== 'issues')) {
      throw new Error('URL must identify one issue or pull request');
    }
    const [owner, repo, kind, numberText] = parts;
    const number = Number(numberText);
    if (!isSafeOwner(owner) || !isSafeRepo(repo) || !isPositiveInteger(number)) {
      throw new Error('invalid owner/repo/number in URL');
    }
    return { owner, repo, number, kind: kind === 'issues' ? 'issue' : 'pull' };
  }

  // owner/repo#number
  const hashMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)#(\d+)$/);
  if (hashMatch) {
    const owner = hashMatch[1];
    const repo = hashMatch[2];
    const number = parseInt(hashMatch[3], 10);
    if (!isSafeOwner(owner) || !isSafeRepo(repo) || !isPositiveInteger(number)) {
      throw new Error('invalid owner/repo/number');
    }
    return { owner, repo, number, kind: 'pull' };
  }

  // owner/repo number
  const spaceMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)\s+(\d+)$/);
  if (spaceMatch) {
    const owner = spaceMatch[1];
    const repo = spaceMatch[2];
    const number = parseInt(spaceMatch[3], 10);
    if (!isSafeOwner(owner) || !isSafeRepo(repo) || !isPositiveInteger(number)) {
      throw new Error('invalid owner/repo/number');
    }
    return { owner, repo, number, kind: 'pull' };
  }

  // Bare number: resolved against context workspace.
  const bareMatch = trimmed.match(/^\d+$/);
  if (bareMatch) {
    const number = parseInt(trimmed, 10);
    if (!isPositiveInteger(number)) throw new Error('invalid number');
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
  if (!result.ok) {
    throw new Error(`gh repo view failed: ${result.stderr || result.stdout}`);
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error('non-JSON gh repo view response');
  }
  const owner = data?.owner?.login;
  const repo = data?.name;
  if (!isSafeOwner(owner) || !isSafeRepo(repo)) {
    throw new Error('gh repo view returned invalid owner/repo');
  }
  return { owner, repo, number };
}

async function ghApi(path, { spawn, paginate = false } = {}) {
  const argv = ['gh', 'api', '--method', 'GET'];
  if (paginate) argv.push('--paginate', '--slurp');
  argv.push(path);
  const result = await run(argv, { spawn, maxBytes: MAX_GH_BYTES });
  if (!result.ok) {
    throw new Error(stripSecrets(result.stderr || result.stdout || `gh api GET ${path} failed`));
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error('non-JSON gh response');
  }
  if (paginate && Array.isArray(data)) {
    const flat = [];
    for (const page of data) {
      if (Array.isArray(page)) flat.push(...page);
      else flat.push(page);
    }
    return flat;
  }
  return data;
}

export async function fetchAuthenticatedLogin({ spawn } = {}) {
  const viewer = await ghApi('user', { spawn });
  if (!isNonEmptyString(viewer?.login, { max: 39 })) throw new Error('authenticated GitHub login is unavailable');
  return viewer.login;
}

export async function fetchIssue({ owner, repo, number }, { spawn } = {}) {
  if (!isSafeOwner(owner) || !isSafeRepo(repo) || !isPositiveInteger(number)) {
    throw new Error('invalid issue target');
  }
  const [issue, commentsRaw] = await Promise.all([
    ghApi(`repos/${owner}/${repo}/issues/${number}`, { spawn }),
    ghApi(`repos/${owner}/${repo}/issues/${number}/comments`, { spawn, paginate: true }),
  ]);
  const warnings = [];
  const comments = boundItems(commentsRaw.map((comment) => ({
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
    state: issue.state,
    url: issue.html_url,
    author: issue.user?.login,
    comments,
    complete: commentsRaw.length <= MAX_ITEMS,
    warnings,
  };
}

export async function fetchPull({ owner, repo, number }, { spawn } = {}) {
  return ghApi(`repos/${owner}/${repo}/pulls/${number}`, { spawn });
}

function parsePatchLineMap(patch) {
  const map = { left: new Set(), right: new Set(), hunks: [] };
  if (typeof patch !== 'string' || patch.length === 0) return map;
  const lines = patch.split('\n');
  let oldLine = null;
  let newLine = null;
  for (const line of lines) {
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      oldLine = parseInt(hunk[1], 10);
      newLine = parseInt(hunk[3], 10);
      map.hunks.push({ oldStart: oldLine, newStart: newLine });
      continue;
    }
    if (oldLine === null || newLine === null) continue;
    if (line.startsWith('-')) {
      map.left.add(oldLine);
      oldLine += 1;
    } else if (line.startsWith('+')) {
      map.right.add(newLine);
      newLine += 1;
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file" — no line number advance.
    } else {
      map.left.add(oldLine);
      map.right.add(newLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return map;
}

function summarizeFile(f, totalBytesUsed) {
  const safePath = isSafeRelativePath(f.filename) &&
    (f.previous_filename === undefined || isSafeRelativePath(f.previous_filename));
  const patch = f.patch || '';
  const patchBytes = Buffer.byteLength(patch, 'utf-8');
  const available = safePath && patchBytes > 0;
  const wouldExceed = totalBytesUsed + patchBytes > MAX_TOTAL_PATCH_BYTES;
  const truncated =
    !available ||
    patchBytes > MAX_PATCH_BYTES_PER_FILE ||
    wouldExceed ||
    (typeof f.changes === 'number' && f.changes > 300);
  const keepPatch = available && !wouldExceed && patchBytes <= MAX_PATCH_BYTES_PER_FILE;
  const lineMap = keepPatch ? parsePatchLineMap(patch) : { left: new Set(), right: new Set(), hunks: [] };
  return {
    filename: f.filename,
    previousFilename: f.previous_filename,
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    changes: f.changes ?? 0,
    patchAvailable: available,
    patchTruncated: truncated,
    patchRedacted: !safePath,
    patchBytes,
    lineMap: {
      left: [...lineMap.left].sort((a, b) => a - b),
      right: [...lineMap.right].sort((a, b) => a - b),
      hunks: lineMap.hunks,
    },
    patch: keepPatch ? patch : undefined,
    bytesUsed: keepPatch ? patchBytes : 0,
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

    const [files, reviews, reviewComments, issueComments] = await Promise.all([
      ghApi(`repos/${owner}/${repo}/pulls/${number}/files`, { spawn, paginate: true }),
      ghApi(`repos/${owner}/${repo}/pulls/${number}/reviews`, { spawn, paginate: true }),
      ghApi(`repos/${owner}/${repo}/pulls/${number}/comments`, { spawn, paginate: true }),
      ghApi(`repos/${owner}/${repo}/issues/${number}/comments`, { spawn, paginate: true }),
    ]);
    const endMeta = await fetchPull({ owner, repo, number }, { spawn });
    const coherent = endMeta.head?.sha === startHead && endMeta.base?.sha === startBase;
    if (coherent) {
      acquired = { meta: endMeta, files, reviews, reviewComments, issueComments };
      break;
    }
    changedDuringAcquisition = true;
    if (attempt === 0) warnings.push('PR head changed during snapshot acquisition; retried once');
  }

  if (!acquired) {
    throw new Error('PR head changed during both snapshot attempts');
  }

  const { meta } = acquired;
  const allFiles = acquired.files;
  const fetchedFiles = allFiles.length;
  const totalChangedFiles = meta.changed_files ?? fetchedFiles;
  if (totalChangedFiles > MAX_CHANGED_FILES || fetchedFiles < totalChangedFiles) {
    warnings.push(`changed files exceed or did not satisfy the ${MAX_CHANGED_FILES} file API limit`);
  }
  const files = allFiles.slice(0, MAX_CHANGED_FILES);

  const feedbackWasCapped =
    acquired.reviews.length > MAX_ITEMS ||
    acquired.reviewComments.length > MAX_ITEMS ||
    acquired.issueComments.length > MAX_ITEMS;
  const feedbackBodyWasTruncated = [
    ...acquired.reviews,
    ...acquired.reviewComments,
    ...acquired.issueComments,
  ].some((item) => typeof item.body === 'string' && item.body.length > MAX_BODY_LENGTH);
  if (feedbackBodyWasTruncated) warnings.push('one or more feedback bodies were truncated');

  const normalizeReview = (review) => ({
    id: review.id,
    state: review.state,
    commitId: review.commit_id,
    body: boundText(review.body, MAX_BODY_LENGTH),
    author: review.user?.login,
    submittedAt: review.submitted_at,
    url: review.html_url,
  });
  const normalizeComment = (comment) => ({
    id: comment.id,
    body: boundText(comment.body, MAX_BODY_LENGTH),
    author: comment.user?.login,
    path: comment.path,
    line: comment.line,
    side: comment.side,
    commitId: comment.commit_id,
    updatedAt: comment.updated_at,
    url: comment.html_url,
  });
  const reviews = boundItems(acquired.reviews.map(normalizeReview), MAX_ITEMS, warnings);
  const reviewComments = boundItems(acquired.reviewComments.map(normalizeComment), MAX_ITEMS, warnings);
  const issueComments = boundItems(acquired.issueComments.map(normalizeComment), MAX_ITEMS, warnings);

  let totalPatchBytes = 0;
  const fileSummaries = files.map((file) => {
    const summary = summarizeFile(file, totalPatchBytes);
    totalPatchBytes += summary.bytesUsed;
    return summary;
  });
  if (fileSummaries.some((file) => file.patchRedacted)) warnings.push('one or more secret-like paths were redacted');
  if (fileSummaries.some((file) => file.patchTruncated)) warnings.push('one or more file patches were unavailable or truncated');

  const feedbackDigest = digestSnapshot(meta, files, acquired.reviews, acquired.reviewComments, acquired.issueComments);
  const headSha = meta.head.sha;
  const baseSha = meta.base.sha;
  const canonicalOwner = meta.base?.repo?.owner?.login ?? owner;
  const canonicalRepo = meta.base?.repo?.name ?? repo;
  if (!isSafeOwner(canonicalOwner) || !isSafeRepo(canonicalRepo)) {
    throw new Error('PR metadata returned an invalid canonical repository identity');
  }
  const allFilesIncluded = totalChangedFiles <= MAX_CHANGED_FILES && fetchedFiles >= totalChangedFiles;
  const patchesComplete = !fileSummaries.some((file) => file.patchTruncated || file.patchRedacted);
  const complete = allFilesIncluded && !feedbackWasCapped && patchesComplete;
  const contentTruncated = feedbackBodyWasTruncated || fileSummaries.some((file) => file.patchTruncated);

  return {
    owner: canonicalOwner,
    repo: canonicalRepo,
    number,
    pull: {
      title: boundText(meta.title, MAX_BODY_LENGTH),
      body: boundText(meta.body, MAX_BODY_LENGTH),
      state: meta.state,
      url: meta.html_url,
      author: meta.user?.login,
      baseRef: meta.base?.ref,
      headRef: meta.head?.ref,
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
    complete,
    contentTruncated,
    completeness: {
      headCoherent: true,
      allFilesIncluded,
      feedbackComplete: !feedbackWasCapped,
      patchesComplete,
      patchesMayBeTruncated: !patchesComplete,
    },
    warnings,
  };
}

export async function fetchSourceAtSha({ owner, repo, sha, path }, { spawn } = {}) {
  if (!is40HexSha(sha)) throw new Error('sha must be a 40-char hex SHA');
  if (!isSafeRelativePath(path)) throw new Error('path must be a safe relative path');
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  const result = await run(
    ['gh', 'api', '--method', 'GET', `repos/${owner}/${repo}/contents/${encodedPath}?ref=${sha}`],
    { spawn, maxBytes: MAX_GH_BYTES },
  );
  if (!result.ok) {
    throw new Error(stripSecrets(result.stderr || result.stdout || 'source fetch failed'));
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error('non-JSON source response');
  }
  if (data.encoding === 'base64' && typeof data.content === 'string') {
    const decoded = Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf-8');
    const contentTruncated = Buffer.byteLength(decoded, 'utf-8') > MAX_SOURCE_BYTES;
    return {
      owner,
      repo,
      sha,
      path,
      name: data.name,
      size: data.size,
      content: contentTruncated ? decoded.slice(0, MAX_SOURCE_BYTES) : decoded,
      contentTruncated,
    };
  }
  return {
    owner,
    repo,
    sha,
    path,
    name: data.name,
    size: data.size,
    content: null,
    message: data.message,
  };
}
