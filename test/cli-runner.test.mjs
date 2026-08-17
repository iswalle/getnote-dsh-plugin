import assert from 'node:assert/strict'
import { chmod } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { GetnoteCliError, runGetnote } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeCli = join(here, '..', 'fixtures', 'fake-getnote.mjs')

test.before(async () => {
  await chmod(fakeCli, 0o755)
})

test('appends the JSON output flag', async () => {
  const result = await runGetnote(['search', 'agent harness'], {
    binaryPath: fakeCli,
  })

  assert.deepEqual(result, {
    args: ['search', 'agent harness', '--output', 'json'],
  })
})

test('surfaces non-zero CLI exits', async () => {
  await assert.rejects(
    runGetnote(['--fail'], { binaryPath: fakeCli }),
    (error) => {
      assert.ok(error instanceof GetnoteCliError)
      assert.equal(error.exitCode, 7)
      assert.match(error.message, /simulated failure/)
      return true
    },
  )
})
