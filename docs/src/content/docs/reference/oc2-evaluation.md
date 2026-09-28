---
title: OC2 model evaluation
description: Build a native catalogue matrix and run a bounded, no-tool source-reading pilot.
---

`naru-eval` evaluates exact native OC2 routes without changing the runtime worker pool. It creates a fresh `[eval] naru-eval:<run-id>:<attempt-id>` session for every attempt in the beta database. The regular session report excludes these tagged sessions by default.

This is a task-conditioned, read-only pilot. The model receives fixed source snippets in its prompt and has no tools. It does not measure editing, command execution, test selection, delegation, or other agentic work.

## Safety contract

- The runner uses OC2's existing native login state. It does not read, copy, or print credentials.
- The runner gives the native host a temporary `HOME`, config directory, cache, state directory, and empty workspace. It points the host at the existing beta data directory and beta database in place. It does not copy either directory or export login records.
- Global and `naru-eval` permissions deny every tool. A temporary policy plugin also removes model tools from the request context.
- Source comes from `git show <pinned-commit>:<path>`. The runner refuses a changed HEAD, a dirty source repository, a digest mismatch, an oversized source file, or a checkout operation.
- The task manifest has a small exact source allowlist. It rejects duplicate paths, secret-like paths, private customer export names, malformed requested formats, and task sources outside the allowlist. Task protocol revision 2 prefixes every supplied source line with its one-based line number, such as `68: const oldestAgeText = ...`.
- The authorization file must set `subscriptionOnly` to `true`, `paidFallback` to `false`, and list every exact route that may run. Catalogue prices never authorize a route and are not used to infer subscription coverage.
- A session retry hook changes every native retry decision to `retry: false`. There is no route fallback. A rate-limit, quota, or payment response stops new dispatches to that provider budget. `opencode` and `opencode-go` share one billing stop group. A structured authentication refusal instead blocks only that exact provider; it does not block the other provider in the shared billing group or trigger login automation. The first `request-invalid` response halts all new dispatches in that batch, before the next task for the same configuration can start.
- The temporary plugin applies `maxTokens` to routes whose transport supports it. OpenAI subscription fast routes are the one explicit exception: beta-19425 serializes `maxTokens` as `max_output_tokens`, which that subscription endpoint rejects, so the plugin omits it. Those attempts record the requested limit, a null applied token cap, and `deadline-only`; they never claim an output-token cap. `max_completion_tokens` belongs to a different protocol and is not substituted.
- `--max-wall-ms` bounds the whole batch. `--max-attempt-wall-ms` bounds each attempt and defaults to 120000 milliseconds. The runner gives an attempt the smaller of its per-attempt limit and the batch time remaining. That deadline covers session creation, prompt admission, generation wait, message read, interrupt, and the final idle wait. On timeout, the runner reports `timeout` only when cancellation is confirmed. Aborting a local fetch is not treated as cancellation.
- Defaults are one concurrent request overall and one per provider budget. Overall concurrency may be raised to three. Per-provider concurrency is fixed at one so a stop cannot race a second request.
- The output directory has an exclusive run lock. Resume freezes the matrix, task manifest and source digests, answer key, authorization, limits, task IDs, fingerprint, and run ID. Partial attempt lines, mismatched checkpoints, and stale locks require manual review.
- Attempts and checkpoints contain requested and API-observed model metadata, status, latency, token usage when the host returns it, the applied budget policy, separate answer-fact and evidence-coverage grades, and bounded diagnostic tags. Input, output, reasoning, cache-read, and cache-write token counts remain separate when the API supplies them. The runner does not assume output counts include or exclude reasoning, and it does not infer billing or quota from those fields. It preserves the API's actual model and variant. It leaves an unverified fast service tier as `unknown`; it does not fabricate priority usage or claim access to an upstream request body that the native API did not expose. Safe tags such as `request-invalid`, `unsupported-output-limit`, `auth-unavailable`, `workspace-required`, and a validated provider error type may be retained. Raw messages, URLs, source, prompts, model prose, keys, and chain of thought are not retained.
- The tagged beta session transcript does contain the submitted prompt, including source snippets, and the model response. Sanitization applies to the separate evaluation artifacts and report, not to the beta database.

## Build a fresh matrix

Run these commands from a built checkout. `discover` uses a temporary empty workspace and config to read the current native host catalogue. It does not load user project instructions, send source prompts, or call a model.

```sh
node .naru-build/tools/naru-eval.mjs discover \
  --output /absolute/private/eval/catalogue.json

node .naru-build/tools/naru-eval.mjs matrix \
  --catalogue /absolute/private/eval/catalogue.json \
  --output /absolute/private/eval/matrix.json
```

The matrix includes every observed `opencode-go` route, every advertised `opencode` route whose ID ends in `-free`, the zero-cost `big-pickle` route, and these named routes when present:

- `xai/grok-4.6`
- `openai/gpt-6-astra-fast`
- `openai/gpt-5.6-sol-fast`
- `openai/gpt-5.6-terra-fast`
- `openai/gpt-5.6-luna-fast`

Each route gets a separate default configuration and one configuration for every advertised variant. Fast aliases retain their route ID, upstream model ID, and observed service-tier settings. Missing named routes remain blocked in the ledger. The matrix records the exact observed route inventories rather than treating a previous free-route count as a permanent rule.

The plan uses one fixed-order sample for each configuration and task. It is exploratory and does not produce a model ranking. Broad competence comparisons remain future work.

## Task and scorer revision 2

Revision 2 replaces the original citation list with a strict JSON Schema response. Each task defines exact fact fields and types. Evidence is keyed by fact ID and contains one to three spans with `path`, `startLine`, and `endLine`. A span may cover at most 20 lines. The optional `briefExplanation` is limited to 1000 characters.

The scorer reports these dimensions separately:

- `answerFacts` uses exact JSON values and types.
- `evidenceCoverage` considers only facts whose answers are correct. A fact is covered when a valid submitted span falls within one of that fact's hidden approved ranges.
- `formatCompliance` records whether the response follows the response schema.
- `invalidEvidence` counts malformed, unsafe, out-of-file, or oversized spans.
- `irrelevantEvidence` counts valid spans that do not fall within approved evidence for their fact.

Numeric strings do not silently become numbers under the `strict-json-types` policy. If a string such as `"89.06"` numerically matches an expected number, the scorer records a semantic diagnostic but leaves the response format-invalid and unscored. This avoids turning a formatting event into a fabricated zero-quality or ungrounded-answer result.

Task digests include the task protocol version, scorer version, numeric policy, numbered-source format, instruction, source paths and hashes, and full response schema. Run, checkpoint, attempt, and report artifacts use schema 3. Resume and report loading reject revision-1 task/scorer data and schema-2 attempts, so old pilot artifacts stay unchanged rather than being silently regraded.

### Local pilot observations

The validity audit found that revision-1 answer facts were generally well calibrated, but its citation metric was not an accuracy measure. One response returned numeric answers as strings, which the old summary displayed like incorrect quality rather than a format event. Another cited the line immediately before a narrow hidden range and received no range coverage even though the source was supplied without visible line numbers. Separate attempts exposed a generic xAI request-shape rejection and an output truncated at the configured cap. These are local transport, format, and scoring observations, not official model grades. Private report paths and pilot scores are not published here.

For a small canary, `matrix` also accepts an exact comma-separated configuration subset. The subset file retains full-inventory route counts and the full configuration count, records every requested configuration ID, and identifies itself as a subset:

```sh
node .naru-build/tools/naru-eval.mjs matrix \
  --catalogue /absolute/private/eval/catalogue.json \
  --configurations 'openai/gpt-6-astra-fast#high,opencode-go/deepseek-v4.1-flash#high' \
  --output /absolute/private/eval/canary-matrix.json
```

## Run the native synthetic acceptance first

This check uses the exact installed beta executable and a loopback fake provider. The macOS sandbox denies non-loopback network access.

```sh
node .naru-build/scripts/naru-eval-smoke.mjs \
  /Users/seangil/.local/share/naru-opencode-v2/versions/0.0.0-beta-19425/opencode2
```

It proves the production dispatcher uses session creation, `/prompt`, `/wait`, and GET `/message`; preserves default and explicit variants; omits `max_output_tokens` only for OpenAI subscription fast routes while retaining the token cap on a supported route; preserves the fast priority overlay; exposes no tools; parses structured invalid-request and workspace-auth failures from HTTP-200 native messages; makes one provider request after a synthetic 429; interrupts a hanging OpenAI request at the wall deadline with no later provider activity; and writes passing deterministic grader records. Do not start a subscription pilot if this check fails.

## Authorize and run a pilot

Create a private authorization file outside the repository. List exact route IDs from the generated matrix. Do not put keys or tokens in this file.

```json
{
  "schemaVersion": 1,
  "subscriptionOnly": true,
  "paidFallback": false,
  "allowedRouteIDs": [
    "opencode-go/example-model",
    "openai/example-fast"
  ]
}
```

The first command below dispatches one attempt. Increase `--max-attempts` only after reviewing its artifacts. Scheduling is configuration-first: with two tasks per configuration, `--max-attempts 4` covers two configurations and `--max-attempts 6` covers three, unless a provider stop skips pending units. The included task manifest is pinned to its recorded repository commit and digests.

```sh
node .naru-build/tools/naru-eval.mjs run \
  --matrix /absolute/private/eval/matrix.json \
  --tasks tests/fixtures/oc2-eval/dollarwise-tasks.json \
  --answer-key tests/fixtures/oc2-eval/answer-key.json \
  --authorization /absolute/private/eval/subscription-only.json \
  --output /absolute/private/eval/run-corrected-001 \
  --max-attempts 6 \
  --max-wall-ms 1200000 \
  --max-attempt-wall-ms 90000 \
  --max-output-tokens 512 \
  --concurrency 1 \
  --provider-concurrency 1
```

Use a new output directory for task/scorer revision 2 and artifact schema 3. Do not resume an older pilot. An existing run directory is never resumed implicitly. After an explicit decision to continue a revision-2 run, repeat the command with the same paths and add `--resume`. A stopped provider budget stays stopped across resume. Clearing a rate, quota, or payment budget requires a separate, exact `--unblock-budget <budget>` flag after a new authorization decision. Authentication blocks are not budget stops and are not cleared with `--unblock-budget`; start a new run only after resolving authentication externally. A `request-invalid` halt also survives resume and has no unblock flag. A parent may create a new matrix and new run for explicitly selected, unaffected providers, but the runner never retries the identical request, changes provider parameters, or falls back by itself. The runner does not copy config or credentials, invoke login, or poll a stopped provider.

`workspace-required` means the remote provider boundary reported that access requires its console/workspace authorization. It does not refer to OC2's local `location.directory`, and a local native config with no provider fields cannot repair it. Unknown provider failures remain generic rather than being inferred as workspace failures.

## Produce a report

```sh
node .naru-build/tools/naru-eval.mjs report \
  --run /absolute/private/eval/run-corrected-001 \
  --output /absolute/private/eval/run-corrected-001-report.json
```

The report includes the frozen batch and per-attempt limits. It marks a configuration `complete` only after every expected task has a completed response. Failed or partial configurations are `attempted`; untouched configurations are `pending`; missing routes are `blocked`; pending configurations for a provider that returned a structured authentication refusal are `blocked-auth`. A configuration that returned `request-invalid` is `request-unsupported`, and the report records `haltedReason: request-invalid`. This describes the request shape, not model quality. Other variants remain pending and untested. Truncated (`finish: length`) responses are `incomplete-output` and are not graded. All unscored failures use null answer and evidence values rather than displaying a misleading `0/N` quality score.

The revision-1 citation metric only checked whether any citation landed inside each hidden range. It was not citation accuracy or precision, and it is unsuitable for model ranking. Existing private pilot reports and scores remain untouched. Local pilot observations may document transport, formatting, timeout, or completion behavior without presenting those old scores as official model grades. These fixed-order, single-sample source-reading tasks still do not establish broad competence or agentic capability.
