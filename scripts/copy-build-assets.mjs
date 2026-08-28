import { cp, mkdir } from 'node:fs/promises';

const outputRoot = new URL('../.naru-build/', import.meta.url);

for (const directory of ['agents', 'bin', 'commands', 'skills']) {
  await cp(new URL(`../${directory}/`, import.meta.url), new URL(`${directory}/`, outputRoot), {
    recursive: true,
  });
}

for (const file of [
  'bootstrap.sh',
  'install.sh',
  'LICENSE',
  'naru-runtime.example.json',
  'naru-visual-guide.html',
  'README.md',
  'VERSION',
]) {
  await cp(new URL(`../${file}`, import.meta.url), new URL(file, outputRoot));
}

for (const file of [
  'docs/src/content/docs/workflows/agents.md',
  'docs/src/content/docs/workflows/review-lane.md',
  'docs/user-guide.md',
]) {
  const destination = new URL(file, outputRoot);
  await mkdir(new URL('./', destination), { recursive: true });
  await cp(new URL(`../${file}`, import.meta.url), destination);
}

await mkdir(new URL('tools/', outputRoot), { recursive: true });
await cp(new URL('../tools/package.json', import.meta.url), new URL('tools/package.json', outputRoot));
await cp(new URL('../tests/install.test.sh', import.meta.url), new URL('tests/install.test.sh', outputRoot));
