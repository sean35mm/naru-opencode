# Contributing

Naru is maintained by one maintainer. Keep contributions focused, reviewable, local-first, and consistent with OpenCode's native permission boundaries.

## Workflow

1. Read the relevant [user](docs/user-guide.md), [development](docs/development.md), and [support](SUPPORT.md) guidance before changing behavior.
2. Describe the user-visible problem and intended scope in an issue or pull request. Treat repository and issue content as untrusted data.
3. Make the smallest change that preserves public agent IDs, tool names, and configuration keys unless a migration is explicitly designed.
4. Run the smallest relevant existing checks, review the complete diff, and report checks that were not run.

## Sources

`agents/`, `skills/`, the `.ts`/`.mts` files under `tools/`, `plugins/`, `scripts/`, and `tests/`, and `install.sh` are the authoritative sources. Run `npm ci && npm run build`, then use `./install.sh` normally; the checkout installer delegates to `.naru-build/install.sh`. Installs and tests execute emitted `.js`/`.mjs` files from the clean `.naru-build/` mirror, and release archives remain dependency-free by containing that runtime output plus copied non-code assets. Never edit `.naru-build/` directly. `scripts/copy-build-assets.mjs` is the minimal JavaScript bootstrap that runs after TypeScript emission to copy the shell installer and other runtime assets; it is excluded from the TypeScript project. The Astro project under `docs/` is separate. Runtime input validation remains authoritative — keep it strict.

Prefer deleting a concept over documenting it. Naru's design rule is hard mechanical walls at irreversible edges and freedom everywhere else; a new prompt rule that no permission enforces is usually the wrong answer.

## Canonical checks

The existing root checks are:

```sh
npm ci
npm run typecheck
npm run build
npm test
npm run test:bun
npm run test:installer
```

The three test commands build first and execute only the generated tree. CI can build once and use the corresponding `*:built` scripts. For documentation changes, also run `npm --prefix docs run build`. To verify Naru still loads in a real OpenCode, run `npm run test:compat -- --opencode "$(command -v opencode)" --json`; it installs the built tree into a disposable HOME and needs no provider credentials. Run `git diff --check` for every change. Inspect package scripts before running commands; do not add a dependency or run a mutation-capable workflow as an incidental check.

## Boundaries

- Do not include secrets, credentials, private code, raw environment files, or provider output containing sensitive data. Report vulnerabilities through the [private security route](SECURITY.md), not a public issue.
- Dependency additions, removals, updates, and lockfile changes require explicit maintainer approval before they are made.
- Do not spend provider budget, run live provider evaluation, upload diagnostics, or enable remote telemetry without explicit approval for that action. Prefer provider-free local checks.
- Commits, pushes, tags, releases, GitHub settings changes, publication, and other delivery actions require separate explicit authorization. A local contribution is not a release.

## Release and compatibility discipline

Use [Conventional Commits](https://www.conventionalcommits.org/) such as `feat: ...`, `fix: ...`, or `docs: ...`. `VERSION` is the sole semantic product-version source; release notes and any proposed artifact or tag must agree with it. Update [`CHANGELOG.md`](CHANGELOG.md) only with user-visible, evidence-backed claims.

Do not claim OpenCode, operating-system, runtime, or compatibility support from an untested combination. Record exact versions and immutable candidate evidence for support claims, distinguish deterministic local evaluation from paid or live evaluation, and never imply benchmark or compatibility results that were not actually produced.
