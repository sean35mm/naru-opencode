import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// npm runs these compiled tests from the checkout root; workflow/config sources
// intentionally are not copied into the runtime build mirror.
const source = (file: string): string => readFileSync(path.join(process.cwd(), file), 'utf8');
const release = source('.github/workflows/release.yml');
const propose = source('.github/workflows/release-please.yml');
const ci = source('.github/workflows/ci.yml');

// Scope contract assertions to a job without introducing a YAML dependency.
function job(workflow: string, name: string): string {
  const match = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:|$(?![\\s\\S]))`, 'm'));
  assert.ok(match, `Missing workflow job: ${name}`);
  return match[0];
}

function contains(text: string, fragments: string[]): void {
  for (const fragment of fragments) assert.ok(text.includes(fragment), `Missing workflow contract: ${fragment}`);
}

test('release proposals use the canonical plain version and prepare drafts, not public releases', () => {
  const config = JSON.parse(source('release-please-config.json'));
  const manifest = JSON.parse(source('.release-please-manifest.json'));
  const root = config.packages['.'];
  assert.deepEqual(Object.keys(config.packages), ['.']);
  assert.equal(manifest['.'], source('VERSION').trim());
  assert.equal(root['release-type'], 'simple');
  assert.equal(root['version-file'], 'VERSION');
  assert.equal(root['changelog-path'], 'CHANGELOG.md');
  assert.equal(root['bump-minor-pre-major'], true);
  assert.equal(root.draft, true);
  assert.equal(root['force-tag-creation'], true);
  assert.equal(root['include-v-in-tag'], true);
  assert.equal(root['include-component-in-tag'], false);
  assert.equal(JSON.parse(source('package.json')).version, undefined);
});

test('bot-created events are bridged with explicit CI dispatch and gated reusable publication', () => {
  const proposal = job(propose, 'propose');
  contains(proposal, [
    "if: github.ref == 'refs/heads/main'",
    'target-branch: main',
    'config-file: release-please-config.json',
    'manifest-file: .release-please-manifest.json',
    'GH_TOKEN: ${{ github.token }}',
    'gh pr list --repo "$GITHUB_REPOSITORY" --state open --base main --head release-please--branches--main',
    'if [ -z "$RELEASE_PR_BRANCH" ]; then exit 0; fi',
    'test "$RELEASE_PR_BRANCH" = release-please--branches--main',
    'gh workflow run ci.yml --repo "$GITHUB_REPOSITORY" --ref "$RELEASE_PR_BRANCH"',
  ]);
  assert.match(ci, /^  workflow_dispatch:/m);
  assert.doesNotMatch(proposal, /if: steps\.release\.outputs\.prs_created/);
  contains(job(propose, 'publish'), [
    'needs: propose',
    "if: needs.propose.outputs.release_created == 'true'",
    'uses: ./.github/workflows/release.yml',
    'tag: ${{ needs.propose.outputs.tag }}',
    'sha: ${{ needs.propose.outputs.sha }}',
  ]);
  contains(proposal, [
    'tag: ${{ steps.release.outputs.tag_name }}',
    'sha: ${{ steps.release.outputs.sha }}',
  ]);
  assert.doesNotMatch(propose, /gh pr (?:merge|review)|--auto|secrets\./);
});

test('release identity and the single built candidate cross both qualification gates', () => {
  const build = job(release, 'build');
  const qualification = job(release, 'qualify-native');
  const publication = job(release, 'release');
  assert.match(release, /^  workflow_call:/m);
  assert.match(release, /^  workflow_dispatch:/m);
  contains(build, [
    'ref: refs/tags/${{ inputs.tag || github.ref_name }}',
    'RELEASE_TAG: ${{ inputs.tag || github.ref_name }}',
    "EXPECTED_SHA: ${{ inputs.sha || (github.ref_type == 'tag' && github.sha) || '' }}",
    'tag !== `v${version}`',
    'sha !== process.env.EXPECTED_SHA',
    'tag: ${{ steps.version.outputs.tag }}',
    'sha: ${{ steps.version.outputs.sha }}',
    'npm run build',
    'uses: actions/upload-artifact@',
    'name: release-candidate',
    'include-hidden-files: true',
  ]);
  contains(qualification, [
    'needs: build', 'fail-fast: false',
    'runner: macos-15', 'host: darwin-arm64',
    'runner: ubuntu-latest', 'host: linux-x64',
    'uses: actions/download-artifact@', 'name: release-candidate',
    'RELEASE_VERSION: ${{ needs.build.outputs.version }}',
    'HOST_INTEGRITY: ${{ matrix.integrity }}',
    'createHash("sha256")', 'createHash("sha512")',
    '--profile native-v2', '--source "$root"',
  ]);
  contains(publication, [
    'needs: [build, qualify-native]',
    'uses: actions/download-artifact@', 'name: release-candidate',
    'RELEASE_TAG: ${{ needs.build.outputs.tag }}',
    'RELEASE_SHA: ${{ needs.build.outputs.sha }}',
    'node .naru-build/scripts/naru-release-publish.mjs',
  ]);
  assert.doesNotMatch(qualification + publication, /npm (?:ci|run build)|actions\/checkout@|continue-on-error:|always\(\)/);
  assert.doesNotMatch(publication, /--clobber|gh release create/);
});

test('workflow credentials default to read-only and external actions are SHA-pinned', () => {
  for (const workflow of [release, propose, ci]) {
    assert.match(workflow, /^permissions:\n  contents: read\n/m);
    for (const [, action] of workflow.matchAll(/\buses:\s*(\S+)/g)) {
      assert.ok(action);
      if (action.startsWith('./')) continue;
      assert.match(action, /^[\w.-]+\/[\w./-]+@[a-f0-9]{40}$/);
    }
  }
  assert.doesNotMatch(job(release, 'build') + job(release, 'qualify-native'), /contents: write/);
  assert.match(job(release, 'release'), /permissions:\n\s+contents: write/);
  assert.match(job(propose, 'propose'), /permissions:\n\s+actions: write/);
  for (const workflow of [release, ci]) {
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@/g)];
    assert.equal([...workflow.matchAll(/persist-credentials: false/g)].length, checkouts.length);
  }
});
