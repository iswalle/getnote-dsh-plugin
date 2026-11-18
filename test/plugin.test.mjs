import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  apiBase,
  apply,
  confirmationReason,
  CredentialStore,
  DeviceLogin,
  DSH_CLIENT_ID,
  GetnoteApi,
  parseJson,
} from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const u = new URL(url)
    const call = {
      method: init.method,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const [status, body] = await handler(call)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
  return { impl, calls }
}

async function tempStore() {
  const dir = await mkdtemp(join(tmpdir(), 'getnote-dsh-'))
  return new CredentialStore(join(dir, 'nested', 'credentials.json'))
}

async function harness(handler, { loggedIn = true } = {}) {
  const store = await tempStore()
  if (loggedIn) await store.save({ apiKey: 'gk_test', clientId: DSH_CLIENT_ID })
  const fetch = fakeFetch(handler)
  const api = new GetnoteApi({
    apiUrl: 'https://api.example.test',
    clientId: DSH_CLIENT_ID,
    store,
    timeoutMs: 5_000,
    fetchImpl: fetch.impl,
    env: {},
  })
  const login = new DeviceLogin(api, async () => {})
  const tools = new Map()
  const hooks = []
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    skills: { registerProvider() {} },
    effect() {},
    on(name, fn) { hooks.push([name, fn]) },
  }
  apply(ctx, { apiUrl: 'https://api.example.test', clientId: DSH_CLIENT_ID, timeoutMs: 5_000 }, { api, login })
  const run = (name, args = {}) => tools.get(name).execute(args, { signal: new AbortController().signal })
  return { tools, hooks, run, calls: fetch.calls, store, login }
}

const ok = data => [200, { success: true, data }]

test('bundles only the DSH-specific guidance skill', async () => {
  const skills = await readdir(join(here, '..', 'skills'))
  assert.deepEqual(skills, ['getnote-dsh'])
})

test('registers the full tool set without any CLI dependency', async () => {
  const { tools } = await harness(() => ok({}))
  assert.deepEqual([...tools.keys()].sort(), [
    'getnote_add_note_tags',
    'getnote_auth_status',
    'getnote_delete_note',
    'getnote_get_note',
    'getnote_kb_add_notes',
    'getnote_kb_remove_notes',
    'getnote_list_kb_notes',
    'getnote_list_knowledge_bases',
    'getnote_list_notes',
    'getnote_login',
    'getnote_logout',
    'getnote_note_outline',
    'getnote_note_section',
    'getnote_read_notes',
    'getnote_remove_note_tag',
    'getnote_save',
    'getnote_search',
    'getnote_share_note',
    'getnote_task_status',
    'getnote_update_note',
  ])
})

test('apiBase accepts host, /open and full prefix forms', () => {
  assert.equal(apiBase('https://openapi.biji.com'), 'https://openapi.biji.com/open/api/v1')
  assert.equal(apiBase('https://x.test/open/'), 'https://x.test/open/api/v1')
  assert.equal(apiBase('https://x.test/open/api/v1'), 'https://x.test/open/api/v1')
})

test('sends auth headers and unwraps the success envelope', async () => {
  const h = await harness(() => ok({ notes: [{ id: '1896830231705320746' }], next_cursor: 'c2' }))
  const out = JSON.parse(await h.run('getnote_list_notes', { limit: 5, cursor: 'c1' }))
  assert.equal(out.notes[0].id, '1896830231705320746')
  const call = h.calls[0]
  assert.equal(call.path, '/open/api/v1/resource/note/list')
  assert.deepEqual(call.query, { limit: '5', cursor: 'c1' })
  assert.equal(call.headers.Authorization, 'Bearer gk_test')
  assert.equal(call.headers['X-Client-ID'], DSH_CLIENT_ID)
})

test('filtered listing uses page_size', async () => {
  const h = await harness(() => ok({ notes: [] }))
  await h.run('getnote_list_notes', { note_type: 'meeting', source: 'vendor_moan' })
  assert.deepEqual(h.calls[0].query, { page_size: '20', note_type: 'meeting', source: 'vendor_moan' })
})

test('search routes to knowledge recall and supports snippets', async () => {
  const h = await harness(() => ok({ results: [] }))
  await h.run('getnote_search', { query: 'agent', limit: 3 })
  await h.run('getnote_search', { query: 'agent', knowledge_base_id: 'kb1', snippet_chars: 200 })
  assert.equal(h.calls[0].path, '/open/api/v1/resource/recall')
  assert.deepEqual(h.calls[0].body, { query: 'agent', top_k: 3 })
  assert.equal(h.calls[1].path, '/open/api/v1/resource/recall/knowledge')
  assert.deepEqual(h.calls[1].body, { query: 'agent', top_k: 10, response_mode: 'snippet', max_snippet_chars: 200, topic_id: 'kb1' })
  await assert.rejects(h.run('getnote_search', { query: 'x', limit: 11 }), RangeError)
})

test('save picks note type from content', async () => {
  const h = await harness(() => ok({ id: 'n1' }))
  await h.run('getnote_save', { content: 'hello', tags: ['a'], idempotency_key: 'k-1' })
  await h.run('getnote_save', { content: 'https://example.com/a' })
  await h.run('getnote_save', { image_urls: ['https://img.test/1.png'], content: 'caption' })
  assert.deepEqual(h.calls[0].body, { note_type: 'plain_text', content: 'hello', tags: ['a'], client_request_id: 'k-1' })
  assert.deepEqual(h.calls[1].body, { note_type: 'link', link_url: 'https://example.com/a' })
  assert.deepEqual(h.calls[2].body, { note_type: 'img_text', image_urls: ['https://img.test/1.png'], content: 'caption' })
  await assert.rejects(h.run('getnote_save', { image_urls: ['/tmp/a.png'] }), /https/)
  await assert.rejects(h.run('getnote_save', {}), /content or image_urls/)
  await assert.rejects(h.run('getnote_save', { content: 'x', idempotency_key: '中文' }), /idempotency_key/)
})

test('write tools send the documented payloads', async () => {
  const h = await harness(() => ok({}))
  await h.run('getnote_update_note', { note_id: 'n1', title: 't' })
  await h.run('getnote_add_note_tags', { note_id: 'n1', tags: [' a ', 'a', 'b'] })
  await h.run('getnote_remove_note_tag', { note_id: 'n1', tag_id: 't9' })
  await h.run('getnote_delete_note', { note_id: 'n1' })
  await h.run('getnote_share_note', { note_id: 'n1', exclude_audio: true })
  await h.run('getnote_kb_add_notes', { topic_id: 'kb', note_ids: ['n1', 'n1', 'n2'] })
  await h.run('getnote_kb_remove_notes', { topic_id: 'kb', note_ids: ['n2'] })
  assert.deepEqual(h.calls.map(c => [c.path.replace('/open/api/v1/resource', ''), c.body]), [
    ['/note/update', { id: 'n1', title: 't' }],
    ['/note/tags/add', { note_id: 'n1', tags: ['a', 'b'] }],
    ['/note/tags/delete', { note_id: 'n1', tag_id: 't9' }],
    ['/note/delete', { note_id: 'n1' }],
    ['/note/sharing', { note_id: 'n1', share_exclude_audio: true }],
    ['/knowledge/note/batch-add', { topic_id: 'kb', note_ids: ['n1', 'n2'] }],
    ['/knowledge/note/remove', { topic_id: 'kb', note_ids: ['n2'] }],
  ])
  await assert.rejects(h.run('getnote_update_note', { note_id: 'n1' }), /title, content, or tags/)
})

test('destructive tools ask for confirmation, others pass through', async () => {
  assert.match(confirmationReason('getnote_delete_note', { note_id: 'n1' }), /删除/)
  assert.match(confirmationReason('getnote_share_note', { note_id: 'n1' }), /公开分享/)
  assert.match(confirmationReason('getnote_update_note', { note_id: 'n1', content: 'x' }), /替换正文/)
  assert.match(confirmationReason('getnote_kb_remove_notes', { topic_id: 'k', note_ids: ['a'] }), /移出知识库/)
  assert.equal(confirmationReason('getnote_update_note', { note_id: 'n1', title: 't' }), undefined)
  assert.equal(confirmationReason('getnote_save', { content: 'x' }), undefined)

  const h = await harness(() => ok({}))
  const [, hook] = h.hooks.find(([name]) => name === 'tools/pre-execute')
  assert.equal((await hook({ name: 'getnote_delete_note', arguments: { note_id: 'n1' } }, () => 'next')).kind, 'ask')
  assert.equal(await hook({ name: 'getnote_get_note', arguments: { note_id: 'n1' } }, () => 'next'), 'next')
})

test('API errors surface message; 401 asks to log in again', async () => {
  const h = await harness(({ path }) => path.endsWith('/note/detail')
    ? [400, { success: false, error: { code: 10001, message: 'note not found' } }]
    : [401, { success: false, error: { code: 10004, message: 'invalid api key' } }])
  await assert.rejects(h.run('getnote_get_note', { note_id: 'x' }), /note not found/)
  await assert.rejects(h.run('getnote_list_notes'), /getnote_login/)
})

test('not logged in: tools tell the model to call getnote_login', async () => {
  const h = await harness(() => ok({}), { loggedIn: false })
  await assert.rejects(h.run('getnote_search', { query: 'x' }), /getnote_login/)
  assert.match(await h.run('getnote_auth_status'), /Not authorized/)
  assert.equal(h.calls.length, 0)
})

test('device login returns the link and stores the key with 0600 permissions', async () => {
  let polls = 0
  const h = await harness(({ path, body }) => {
    if (path.endsWith('/oauth/device/code')) {
      assert.deepEqual(body, { client_id: DSH_CLIENT_ID })
      return ok({ code: 'dc1', user_code: 'ABCD', verification_uri: 'https://auth.test/x', expires_in: 600, interval: 1 })
    }
    if (path.endsWith('/oauth/token')) {
      assert.deepEqual(body, { grant_type: 'device_code', client_id: DSH_CLIENT_ID, code: 'dc1' })
      polls += 1
      if (polls < 2) return [400, { success: false, error: { code: 'authorization_pending', message: 'authorization_pending' } }]
      return ok({ client_id: DSH_CLIENT_ID, api_key: 'gk_new', expires_at: 1900000000 })
    }
    return ok({})
  }, { loggedIn: false })

  const text = await h.run('getnote_login')
  assert.match(text, /https:\/\/auth\.test\/x/)
  assert.match(text, /ABCD/)
  assert.doesNotMatch(text, /gk_/)
  await h.login.wait()
  assert.equal(h.login.lastResult, 'authorized')
  assert.equal((await h.store.load()).apiKey, 'gk_new')
  assert.equal((await stat(h.store.path)).mode & 0o777, 0o600)
  assert.doesNotMatch(await h.run('getnote_auth_status'), /gk_/)
  assert.match(await h.run('getnote_login'), /Already authorized/)

  await h.run('getnote_logout')
  assert.equal(await h.store.load(), undefined)
  await assert.rejects(readFile(h.store.path))
})

test('device login reports rejection', async () => {
  const h = await harness(({ path }) => path.endsWith('/oauth/device/code')
    ? ok({ code: 'dc', user_code: 'U', verification_uri: 'https://auth.test/y', expires_in: 600, interval: 1 })
    : [400, { success: false, error: { code: 'rejected', message: 'rejected' } }], { loggedIn: false })
  await h.run('getnote_login')
  await h.login.wait()
  assert.equal(h.login.lastResult, 'rejected')
  assert.match(await h.run('getnote_auth_status'), /rejected/)
})

test('keeps 64-bit note IDs exact', async () => {
  assert.deepEqual(
    parseJson('{"id":1927369631023030586,"n":12,"f":-1.5e3,"s":"x\\"1927369631023030586","a":[9007199254740993]}'),
    { id: '1927369631023030586', n: 12, f: -1500, s: 'x"1927369631023030586', a: ['9007199254740993'] },
  )
  const h = await harness(() => [200, '{"success":true,"data":{"id":1927369631023030586,"note_id":"1927369631023030586"}}'])
  assert.match(await h.run('getnote_save', { content: 'x' }), /"id": "1927369631023030586"/)
})

test('unfiltered list is trimmed to limit with a continuation cursor', async () => {
  const notes = Array.from({ length: 20 }, (_, i) => ({ note_id: String(100 - i) }))
  const h = await harness(() => ok({ notes, has_more: true, next_cursor: '81' }))
  const out = JSON.parse(await h.run('getnote_list_notes', { limit: 3 }))
  assert.deepEqual(out.notes.map(n => n.note_id), ['100', '99', '98'])
  assert.equal(out.next_cursor, '98')
  assert.equal(out.has_more, true)
})
