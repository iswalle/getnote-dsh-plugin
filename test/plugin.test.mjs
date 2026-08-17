import assert from 'node:assert/strict'
import test from 'node:test'

import { apply } from '../lib/index.js'

test('registers the GetNote skill provider and six model tools', () => {
  const tools = []
  const skillProviders = []
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
      },
    },
    skills: {
      registerProvider(provider) {
        skillProviders.push(provider)
      },
    },
    effect() {},
    on() {},
  }

  apply(ctx, {
    timeoutMs: 120_000,
    maxOutputBytes: 10 * 1024 * 1024,
  })

  assert.equal(skillProviders.length, 1)
  assert.deepEqual(
    tools.map(tool => tool.name),
    [
      'getnote_auth_status',
      'getnote_search',
      'getnote_save',
      'getnote_list_notes',
      'getnote_get_note',
      'getnote_list_knowledge_bases',
    ],
  )
})
