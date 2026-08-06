import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const assemblerPath = join(root, '.naru-build', 'emit', 'build', 'candidate-assembler.js');

async function collect(directory, predicate, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await collect(absolute, predicate, base));
    else if (entry.isFile() && predicate(entry.name)) paths.push(relative(base, absolute).split(sep).join('/'));
  }
  return paths.sort();
}

test('root TypeScript policy is strict NodeNext without a JavaScript source bridge', async () => {
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const typecheck = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'));
  const build = JSON.parse(await readFile(join(root, 'tsconfig.build.json'), 'utf8'));
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, 'module');
  assert.deepEqual(packageJson.devDependencies, { '@types/node': '24.10.1', typescript: '5.9.3' });
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(typecheck.compilerOptions.module, 'NodeNext');
  assert.equal(typecheck.compilerOptions.moduleResolution, 'NodeNext');
  assert.equal(typecheck.compilerOptions.verbatimModuleSyntax, true);
  assert.equal(typecheck.compilerOptions.strict, true);
  assert.equal(typecheck.compilerOptions.target, 'ES2023');
  assert.equal(typecheck.compilerOptions.allowJs, false);
  assert.equal(typecheck.compilerOptions.checkJs, false);
  assert.equal(typecheck.compilerOptions.exactOptionalPropertyTypes, true);
  assert.equal(typecheck.compilerOptions.noUncheckedIndexedAccess, true);
  assert.equal(typecheck.compilerOptions.useUnknownInCatchVariables, true);
  assert.equal(typecheck.compilerOptions.noImplicitReturns, true);
  assert.equal(typecheck.compilerOptions.noFallthroughCasesInSwitch, true);
  assert.equal(typecheck.compilerOptions.noImplicitOverride, true);
  assert.equal(typecheck.compilerOptions.noEmitOnError, true);
  assert.equal(typecheck.compilerOptions.skipLibCheck, false);
  assert.deepEqual(typecheck.include, ['src/**/*.d.ts', 'src/**/*.mts', 'src/**/*.ts']);
  assert.equal(build.compilerOptions.declaration, false);
  assert.equal(build.compilerOptions.declarationMap, false);
  assert.equal(build.compilerOptions.inlineSourceMap, false);
  assert.equal(build.compilerOptions.sourceMap, false);
  assert.equal(build.compilerOptions.outDir, '.naru-build/emit');
});

test('every production JS/MJS module has one authoritative source mapping', async () => {
  const { MIRRORED_MODULES } = await import(`file://${assemblerPath}`);
  const publicModules = [
    ...(await collect(join(root, 'plugins'), name => /\.(?:js|mjs)$/.test(name))).map(path => `plugins/${path}`),
    ...(await collect(join(root, 'scripts'), name => /\.(?:js|mjs)$/.test(name))).map(path => `scripts/${path}`),
    ...(await collect(join(root, 'tools'), name => /\.(?:js|mjs)$/.test(name))).map(path => `tools/${path}`),
  ].sort();
  const targets = MIRRORED_MODULES.map(mapping => mapping.target).sort();
  assert.deepEqual(targets, publicModules);
  assert.equal(new Set(MIRRORED_MODULES.map(mapping => mapping.source)).size, publicModules.length);
  for (const mapping of MIRRORED_MODULES) {
    const expectedSource = `src/${mapping.target}`.replace(/\.mjs$/, '.mts').replace(/\.js$/, '.ts');
    assert.equal(mapping.source, expectedSource);
    assert.equal(mapping.emitted, mapping.target);
  }
  assert.equal(MIRRORED_MODULES.filter(mapping => mapping.source.endsWith('.ts')).length, 8);
  assert.equal(MIRRORED_MODULES.filter(mapping => mapping.source.endsWith('.mts')).length, 23);
});

test('source policy forbids broad TypeScript suppressions and undeclared loader TSX', async () => {
  const sourceFiles = await collect(join(root, 'src'), name => /\.(?:js|mjs|ts|mts|cts|tsx)$/.test(name));
  assert.equal(sourceFiles.some(path => /\.(?:js|mjs)$/.test(path)), false);
  for (const path of sourceFiles) {
    const text = await readFile(join(root, 'src', path), 'utf8');
    assert.doesNotMatch(text, /@ts-(?:ignore|nocheck|expect-error)|eslint-disable|:\s*any\b|<any>/, path);
  }
  const publicTypeScript = [
    ...(await collect(join(root, 'plugins'), name => /\.(?:ts|tsx|mts|cts)$/.test(name))).map(path => `plugins/${path}`),
    ...(await collect(join(root, 'scripts'), name => /\.(?:ts|tsx|mts|cts)$/.test(name))).map(path => `scripts/${path}`),
    ...(await collect(join(root, 'tools'), name => /\.(?:ts|tsx|mts|cts)$/.test(name))).map(path => `tools/${path}`),
  ].sort();
  assert.deepEqual(publicTypeScript, ['plugins/naru-minions-dashboard.tsx']);
});
