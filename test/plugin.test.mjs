import assert from 'node:assert/strict'
import { chmod, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { apply, confirmationReason, STDIN_THRESHOLD } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fakeCli = join(here, '..', 'fixtures', 'fake-getnote.mjs')

function load() {
  const tools = new Map()
  const skillProviders = []
  const listeners = {}
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    skills: { registerProvider(provider) { skillProviders.push(provider) } },
    effect() {},
    on(event, listener) { listeners[event] = listener },
  }
  apply(ctx, { binaryPath: fakeCli, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 })
  return { tools, skillProviders, listeners }
}

async function call(tools, name, args) {
  const tool = tools.get(name)
  assert.ok(tool, `tool ${name} is registered`)
  const text = await tool.execute(args, { signal: new AbortController().signal, deferContext() {} })
  return JSON.parse(text)
}

test.before(async () => {
  await chmod(fakeCli, 0o755)
})

test('bundles only the DSH-specific guidance skill', async () => {
  const skills = await readdir(join(here, '..', 'skills'))
  assert.deepEqual(skills, ['getnote-dsh'])
})

test('registers the skill provider and every CLI-backed tool', () => {
  const { tools, skillProviders } = load()
  assert.equal(skillProviders.length, 1)
  assert.deepEqual([...tools.keys()].sort(), [
    'getnote_add_note_tag',
    'getnote_auth_status',
    'getnote_create_knowledge_base',
    'getnote_delete_note',
    'getnote_find_course',
    'getnote_get_note',
    'getnote_get_sprout',
    'getnote_kb_add_notes',
    'getnote_kb_create_directory',
    'getnote_kb_delete_directory',
    'getnote_kb_follow_blogger',
    'getnote_kb_follow_live',
    'getnote_kb_get_blogger_content',
    'getnote_kb_get_live',
    'getnote_kb_list_blogger_contents',
    'getnote_kb_list_bloggers',
    'getnote_kb_list_directories',
    'getnote_kb_list_lives',
    'getnote_kb_remove_notes',
    'getnote_kb_update_directory',
    'getnote_list_kb_notes',
    'getnote_list_knowledge_bases',
    'getnote_list_note_tags',
    'getnote_list_notes',
    'getnote_list_sprouts',
    'getnote_note_marks',
    'getnote_note_outline',
    'getnote_note_section',
    'getnote_note_view',
    'getnote_quota',
    'getnote_read_notes',
    'getnote_remove_note_tag',
    'getnote_save',
    'getnote_search',
    'getnote_share_note',
    'getnote_task_status',
    'getnote_update_note',
  ])
})

test('list_notes paginates with --cursor (CLI removed --since-id) and keeps since_id as alias', async () => {
  const { tools } = load()
  assert.deepEqual((await call(tools, 'getnote_list_notes', { cursor: '1914025811879486080', note_type: 'meeting', source: 'vendor_moan' })).args, [
    'notes', '--limit', '20', '--cursor', '1914025811879486080', '--note-type', 'meeting', '--source', 'vendor_moan', '--output', 'json',
  ])
  assert.deepEqual((await call(tools, 'getnote_list_notes', { since_id: '42', limit: 5 })).args, [
    'notes', '--limit', '5', '--cursor', '42', '--output', 'json',
  ])
})

test('maps reading tools to CLI commands', async () => {
  const { tools } = load()
  const cases = [
    ['getnote_note_outline', { note_id: '123' }, ['note', 'outline', '123']],
    ['getnote_note_section', { note_id: '123', offset: 8000, limit: 8000, version: 'v1' }, ['note', 'section', '123', '--offset', '8000', '--limit', '8000', '--version', 'v1']],
    ['getnote_note_section', { note_id: '123', keyword: '绩效|晋升' }, ['note', 'section', '123', '--keyword', '绩效|晋升']],
    ['getnote_note_view', { note_id: '123', view: 'transcript' }, ['note', 'transcript', '123']],
    ['getnote_note_view', { note_id: '123', view: 'quick-note' }, ['note', 'quick-note', '123']],
    ['getnote_read_notes', { note_ids: ['1', '2'], fields: ['content', 'original'], max_total_chars: 16000 }, ['notes', 'batch', '1', '2', '--fields', 'content,original', '--max-total-chars', '16000']],
    ['getnote_search', { query: 'q', snippet_chars: 300 }, ['search', 'q', '--limit', '10', '--response-mode', 'snippet', '--max-snippet-chars', '300']],
    ['getnote_find_course', { teacher: '张三' }, ['references', 'list', '--source', 'dedao', '--resource-type', 'course', '--author', '张三']],
    ['getnote_list_knowledge_bases', { subscribed: true, scope: 'BOOKSPACE' }, ['kbs-sub', '--scope', 'BOOKSPACE']],
    ['getnote_list_kb_notes', { topic_id: 'vnr', page: 2 }, ['kb', 'vnr', '--page', '2']],
    ['getnote_list_sprouts', { month: '2026-11', cursor: 'c1' }, ['sprouts', '2026-11', '--limit', '20', '--since-id', 'c1']],
    ['getnote_kb_get_live', { topic_id: 'vnr', live_id: 'l1' }, ['kb', 'live', 'vnr', 'l1']],
  ]
  for (const [name, args, expected] of cases) {
    assert.deepEqual((await call(tools, name, args)).args, [...expected, '--output', 'json'], name)
  }
})

test('maps writing tools and passes --yes only where the CLI requires it', async () => {
  const { tools } = load()
  const cases = [
    ['getnote_update_note', { note_id: '1', title: '新标题' }, ['note', 'update', '1', '--title', '新标题']],
    ['getnote_update_note', { note_id: '1', tags: ['工作', '重点'] }, ['note', 'update', '1', '--tag', '工作,重点', '--yes']],
    ['getnote_delete_note', { note_id: '1' }, ['note', 'delete', '1', '--yes']],
    ['getnote_share_note', { note_id: '1', exclude_audio: true }, ['note', 'share', '1', '--exclude-audio', '--yes']],
    ['getnote_kb_add_notes', { topic_id: 't', note_ids: ['1', '2'], directory_id: 'd' }, ['kb', 'add', 't', '1', '2', '--directory-id', 'd']],
    ['getnote_kb_remove_notes', { topic_id: 't', note_ids: ['1'] }, ['kb', 'remove', 't', '1', '--yes']],
    ['getnote_kb_create_directory', { topic_id: 't', name: '资料', parent_id: 'p' }, ['kb', 'directory-create', 't', '--name', '资料', '--parent-id', 'p']],
    ['getnote_kb_delete_directory', { topic_id: 't', directory_id: 'd' }, ['kb', 'directory-delete', 't', 'd', '--yes']],
    ['getnote_add_note_tag', { note_id: '1', tag: '工作' }, ['tag', 'add', '1', '工作']],
    ['getnote_create_knowledge_base', { name: '产品研究', description: '资料' }, ['kb', 'create', '产品研究', '--desc', '资料']],
    ['getnote_save', { content: 'hello', topic_id: 't', idempotency_key: 'k1' }, ['save', 'hello', '--topic-id', 't', '--idempotency-key', 'k1']],
  ]
  for (const [name, args, expected] of cases) {
    assert.deepEqual((await call(tools, name, args)).args, [...expected, '--output', 'json'], name)
  }
})

test('save sends long text through stdin instead of argv', async () => {
  const { tools } = load()
  const content = '长'.repeat(STDIN_THRESHOLD + 1)
  const result = await call(tools, 'getnote_save', { content, title: 't' })
  assert.deepEqual(result.args, ['save', '--stdin', '--title', 't', '--output', 'json'])
  assert.equal(result.stdin, content)
})

test('rejects invalid input before running the CLI', async () => {
  const { tools } = load()
  const exec = { signal: new AbortController().signal, deferContext() {} }
  await assert.rejects(tools.get('getnote_update_note').execute({ note_id: '1' }, exec))
  await assert.rejects(tools.get('getnote_kb_add_notes').execute({ topic_id: 't', note_ids: [] }, exec))
  await assert.rejects(tools.get('getnote_find_course').execute({}, exec))
  await assert.rejects(tools.get('getnote_list_sprouts').execute({ month: '2026-13' }, exec))
})

test('asks the user before destructive or publishing calls', async () => {
  const { listeners } = load()
  const gate = listeners['tools/pre-execute']
  assert.ok(gate)
  const allow = async () => ({ kind: 'allow' })
  const decide = (name, args) => gate({ name, arguments: args }, allow)

  for (const [name, args] of [
    ['getnote_delete_note', { note_id: '1' }],
    ['getnote_share_note', { note_id: '1' }],
    ['getnote_update_note', { note_id: '1', content: 'x' }],
    ['getnote_update_note', { note_id: '1', tags: [] }],
    ['getnote_kb_remove_notes', { topic_id: 't', note_ids: ['1'] }],
    ['getnote_kb_delete_directory', { topic_id: 't', directory_id: 'd' }],
  ]) {
    assert.equal((await decide(name, args)).kind, 'ask', name)
  }
  for (const [name, args] of [
    ['getnote_update_note', { note_id: '1', title: 'x' }],
    ['getnote_save', { content: 'x' }],
    ['getnote_search', { query: 'x' }],
    ['other_plugin_tool', {}],
  ]) {
    assert.equal((await decide(name, args)).kind, 'allow', name)
  }
  assert.equal(confirmationReason('getnote_get_note', { note_id: '1' }), undefined)
})
