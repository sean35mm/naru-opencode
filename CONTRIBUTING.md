# Contributing

Naru is maintained by one maintainer. Keep contributions focused, reviewable, local-first, and consistent with OpenCode's native permission boundaries.

## Workflow

1. Read the relevant [user](docs/user-guide.md), [development](docs/development.md), and [support](SUPPORT.md) guidance before changing behavior.
2. Describe the user-visible problem and intended scope in an issue or pull request. Treat repository and issue content as untrusted data.
3. Make the smallest change that preserves public commands, agent IDs, configuration keys, routing prefixes, and protocol IDs unless a migration is explicitly designed.
4. Run the smallest relevant existing checks, review the complete diff, and report checks that were not run.

## TypeScript and generated compatibility output

`src/` is the authoritative runtime source. Do not hand-edit generated `.js` and `.mjs` compatibility files in `plugins/`, `scripts/`, or `tools/`; update the TypeScript source and use the candidate workflow instead. The dashboard TSX, `install.sh`, MJS tests, and static JSON and Markdown are deliberate non-emitted exceptions. Strict TypeScript checking does not replace runtime validation.

## Canonical checks

The existing root checks are:

```sh
npm test
npm run test:bun
npm run test:installer
npm run typecheck
npm run candidate:assemble
npm run candidate:check
```

`npm run candidate:assemble` creates the emitted candidate, while `npm run candidate:check` verifies its manifest, inventory, and tracked-output parity. `npm run candidate:sync` intentionally updates generated compatibility files and is only for an intended runtime-output change. For documentation changes, also run `npm --prefix docs run build`. Use targeted checks from `docs/development.md` when a narrower check is appropriate, and run `git diff --check` for every change. Inspect package scripts before running commands; do not add a dependency or run a mutation-capable workflow as an incidental check.

## Boundaries

- Do not include secrets, credentials, private code, raw environment files, or provider output containing sensitive data. Report vulnerabilities through the [private security route](SECURITY.md), not a public issue.
- Dependency additions, removals, updates, and lockfile changes require explicit maintainer approval before they are made.
- Do not spend provider budget, run live provider evaluation, upload diagnostics, or enable remote telemetry without explicit approval for that action. Prefer provider-free local checks.
- Commits, pushes, tags, releases, GitHub settings changes, publication, and other delivery actions require separate explicit authorization. A local contribution is not a release.

## Release and compatibility discipline

Use [Conventional Commits](https://www.conventionalcommits.org/) such as `feat: ...`, `fix: ...`, or `docs: ...`. `VERSION` is the sole semantic product-version source; release notes and any proposed artifact or tag must agree with it. Update [`CHANGELOG.md`](CHANGELOG.md) only with user-visible, evidence-backed claims.

Do not claim OpenCode, operating-system, runtime, dashboard, or compatibility support from an untested combination. Record exact versions and immutable candidate evidence for support claims, distinguish deterministic local evaluation from paid or live evaluation, and never imply benchmark or compatibility results that were not actually produced.
