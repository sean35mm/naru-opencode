import assert from 'node:assert/strict'
import { defaultSpawn } from '../tools/naru-lib/transport.mjs'

const result = await defaultSpawn(
  [process.execPath, '-e', 'process.stdin.pipe(process.stdout)'],
  { input: 'naru-stdin-smoke', maxBytes: 1024, timeout: 5000 },
)

assert.equal(result.ok, true)
assert.equal(result.stdout, 'naru-stdin-smoke')
assert.equal(result.stdoutTruncated, false)
console.log('OK bun transport')
