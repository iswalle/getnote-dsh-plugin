import type { Context } from '@deepseek-ai/cordis'
import { apply as applySkillFilesystem } from '@deepseek-ai/dsh-skill-filesystem'
import { defineTool, type InferArgs, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import {
  CredentialStore,
  DEFAULT_API_URL,
  defaultCredentialPath,
  DeviceLogin,
  DSH_CLIENT_ID,
  GetnoteApi,
} from './api.js'

export const name = 'getnote-tools'
export const inject = ['tools', 'skills']

export interface Config {
  apiUrl: string
  clientId: string
  credentialPath?: string
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  apiUrl: Schema.string().default(DEFAULT_API_URL).description('GetNote OpenAPI base URL. Change only for integration testing.'),
  clientId: Schema.string().default(DSH_CLIENT_ID).description('OpenAPI client ID used for authorization.'),
  credentialPath: Schema.string().description('Where the authorized API key is stored. Default: $DSH_HOME/getnote/credentials.json.'),
  timeoutMs: Schema.number().min(1_000).default(60_000),
})

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }
}

function renderJson(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

export function integerInRange(value: number | undefined, fallback: number | undefined, min: number, max: number): number | undefined {
  const resolved = value ?? fallback
  if (resolved === undefined) return undefined
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`value must be an integer between ${min} and ${max}`)
  }
  return resolved
}

function ids(values: readonly string[] | undefined, label: string, max: number): string[] {
  const list = [...new Set((values ?? []).map(v => v.trim()).filter(Boolean))]
  if (list.length === 0) throw new RangeError(`${label} must contain at least one ID`)
  if (list.length > max) throw new RangeError(`${label} accepts at most ${max} IDs`)
  return list
}

const URL_PATTERN = /^https?:\/\/\S+$/i

// ---------------------------------------------------------------------------
// Confirmation policy
// ---------------------------------------------------------------------------

/**
 * Tools that delete, publish, or overwrite user data. The plugin asks the user
 * (DSH approval) before dispatching them; without an approval seam DSH turns
 * the ask into a denial, so these never run unattended.
 */
export function confirmationReason(toolName: string, args: unknown): string | undefined {
  const a = (args ?? {}) as Record<string, unknown>
  switch (toolName) {
    case 'getnote_delete_note':
      return `删除得到大脑笔记 ${String(a.note_id)}（移入回收站）`
    case 'getnote_share_note':
      return `公开分享笔记 ${String(a.note_id)}，任何拿到链接的人都能查看`
    case 'getnote_update_note': {
      const parts: string[] = []
      if (a.content !== undefined) parts.push('替换正文')
      if (a.tags !== undefined) parts.push('替换全部标签')
      return parts.length > 0 ? `${parts.join('并')}：笔记 ${String(a.note_id)}` : undefined
    }
    case 'getnote_kb_remove_notes':
      return `把 ${Array.isArray(a.note_ids) ? a.note_ids.length : 0} 条笔记移出知识库 ${String(a.topic_id)}`
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Shared parameter specs
// ---------------------------------------------------------------------------

const noteId = { type: 'string', required: true, description: 'Note ID. Always keep it as a string.' } as const
const topicId = { type: 'string', required: true, description: 'Knowledge base ID (topic_id) from getnote_list_knowledge_bases.' } as const

const NOTE_TYPES = [
  'plain_text', 'link', 'img_text', 'ref', 'audio', 'local_audio', 'class_audio',
  'meeting', 'internal_record', 'recorder_audio', 'recorder_flash_audio',
] as const

const noteFilters = {
  note_type: {
    type: 'string',
    enum: NOTE_TYPES,
    description: 'Exact note type. plain_text=文本, link=链接, img_text=图片, ref=引用, audio=即时录音, local_audio=上传音频, class_audio=课堂录音, meeting=会议（含录音台/耳机）, internal_record=内录, recorder_audio/recorder_flash_audio=录音卡长录音/闪念.',
  },
  source: { type: 'string', description: 'Exact note source, e.g. vendor_moan=录音台, getseed=录音卡, dedao=得到.' },
  created_from: { type: 'string', description: 'Created at or after this RFC3339 time (inclusive).' },
  created_to: { type: 'string', description: 'Created before this RFC3339 time (exclusive).' },
  edited_from: { type: 'string', description: 'Edited at or after this RFC3339 time (inclusive).' },
  edited_to: { type: 'string', description: 'Edited before this RFC3339 time (exclusive).' },
} as const

type FilterArgs = {
  note_type?: string, source?: string,
  created_from?: string, created_to?: string, edited_from?: string, edited_to?: string,
}

function filterQuery(a: FilterArgs): Record<string, string | undefined> {
  return {
    note_type: a.note_type,
    source: a.source,
    created_from: a.created_from,
    created_to: a.created_to,
    edited_from: a.edited_from,
    edited_to: a.edited_to,
  }
}

function hasFilters(a: FilterArgs): boolean {
  return Object.values(filterQuery(a)).some(v => v !== undefined && v !== '')
}

/**
 * The unfiltered note list returns a fixed page (20) regardless of `limit`.
 * Trim it like the CLI does and continue from the last returned note.
 */
export function trimPage(page: unknown, limit: number): unknown {
  const data = page as { notes?: Array<{ note_id?: unknown, id?: unknown }>, [key: string]: unknown } | null
  if (!data || !Array.isArray(data.notes) || data.notes.length <= limit) return page
  const notes = data.notes.slice(0, limit)
  const last = notes[notes.length - 1]
  const cursor = String(last?.note_id || last?.id || '')
  return { ...data, notes, cursor, next_cursor: cursor, has_more: true }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export interface Runtime {
  api: GetnoteApi
  login: DeviceLogin
}

export function createRuntime(config: Config, fetchImpl?: typeof fetch): Runtime {
  const store = new CredentialStore(config.credentialPath || defaultCredentialPath())
  const api = new GetnoteApi({
    apiUrl: config.apiUrl || DEFAULT_API_URL,
    clientId: config.clientId || DSH_CLIENT_ID,
    store,
    timeoutMs: config.timeoutMs ?? 60_000,
    fetchImpl,
  })
  return { api, login: new DeviceLogin(api) }
}

export function apply(ctx: Context, config: Config, runtime: Runtime = createRuntime(config)) {
  const { api, login } = runtime

  applySkillFilesystem(ctx, {
    providerName: 'getnote',
    includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('../skills', import.meta.url)),
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = confirmationReason(exec.name, exec.arguments)
    if (reason) return { kind: 'ask', reason }
    return next()
  })
  // Stop background authorization polling when the plugin is unloaded.
  ctx.effect(() => () => login.cancel(), 'getnote device login')

  function tool<const S extends ParameterSchemaSpec>(def: {
    name: string
    description: string
    parameters: S
    readOnly?: boolean
    run(args: InferArgs<S>, signal: AbortSignal): Promise<unknown>
  }) {
    ctx.tools.register(defineTool({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: textOutput(),
      ...(def.readOnly ? { isConcurrencySafe: () => true } : {}),
      async execute(args, exec) {
        return renderJson(await def.run(args, exec.signal))
      },
    }))
  }

  // ---- Authorization -------------------------------------------------------

  tool({
    name: 'getnote_login',
    description: 'Start GetNote (得到大脑) authorization. Returns a link and a code; show both to the user and ask them to open the link, log in, and confirm. The plugin finishes in the background; then call getnote_auth_status.',
    parameters: {},
    async run(_args, signal) {
      if (await api.credential()) {
        return 'Already authorized with GetNote. To switch accounts, call getnote_logout first.'
      }
      const start = await login.start(signal)
      const minutes = Math.max(1, Math.round(start.expiresIn / 60))
      return [
        'Ask the user to open this link, log in to 得到大脑, and confirm the authorization:',
        start.verificationUri,
        `Confirmation code shown on the page: ${start.userCode}`,
        `The link expires in about ${minutes} minutes. After the user confirms, call getnote_auth_status.`,
      ].join('\n')
    },
  })

  tool({
    name: 'getnote_auth_status',
    description: 'Check whether GetNote is authorized and the authorization still works.',
    parameters: {},
    readOnly: true,
    async run(_args, signal) {
      if (!(await api.credential())) {
        if (login.inProgress) return `Authorization pending: the user has not confirmed yet. Link: ${login.inProgress.verificationUri}`
        if (login.lastResult === 'rejected') return 'The user rejected the authorization. Call getnote_login to try again.'
        if (login.lastResult === 'expired') return 'The authorization link expired. Call getnote_login to get a new one.'
        if (login.lastResult === 'failed') return `Authorization failed: ${login.lastError ?? 'unknown error'}. Call getnote_login to try again.`
        return 'Not authorized. Call getnote_login.'
      }
      await api.get('/resource/rate-limit/quota', {}, signal)
      return 'Authorized with GetNote.'
    },
  })

  tool({
    name: 'getnote_logout',
    description: 'Remove the locally stored GetNote authorization. It does not revoke the grant on the server; the user can revoke it in the GetNote account settings.',
    parameters: {},
    async run() {
      login.cancel()
      await api.options.store.clear()
      return 'Local GetNote authorization removed.'
    },
  })

  tool({
    name: 'getnote_quota',
    description: 'Show the account\'s current API quota and usage. All users can call the API; members have higher quotas.',
    parameters: {},
    readOnly: true,
    run: (_a, signal) => api.get('/resource/rate-limit/quota', {}, signal),
  })

  // ---- Finding notes -------------------------------------------------------

  tool({
    name: 'getnote_search',
    description: 'Semantically search the user\'s notes, optionally within one knowledge base.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language search query.' },
      knowledge_base_id: { type: 'string', description: 'Optional knowledge base (topic) ID.' },
      limit: { type: 'integer', default: 10, description: 'Maximum results, 1-10.' },
      snippet_chars: { type: 'integer', description: 'Return snippets of at most this many characters (100-1000) instead of full bodies, to keep results compact.' },
    },
    readOnly: true,
    async run(a, signal) {
      const body: Record<string, unknown> = { query: a.query, top_k: integerInRange(a.limit, 10, 1, 10) }
      const snippet = integerInRange(a.snippet_chars, undefined, 100, 1000)
      if (snippet !== undefined) Object.assign(body, { response_mode: 'snippet', max_snippet_chars: snippet })
      if (a.knowledge_base_id) {
        body.topic_id = a.knowledge_base_id
        return await api.post('/resource/recall/knowledge', body, signal)
      }
      return await api.post('/resource/recall', body, signal)
    },
  })

  tool({
    name: 'getnote_list_notes',
    description: 'List the user\'s notes, newest first, with optional filters. Paginate with next_cursor from the previous page.',
    parameters: {
      limit: { type: 'integer', default: 20, description: 'Notes per page, 1-100.' },
      cursor: { type: 'string', description: 'next_cursor returned by the previous page.' },
      topic_id: { type: 'string', description: 'Only notes in this knowledge base.' },
      ...noteFilters,
    },
    readOnly: true,
    async run(a, signal) {
      const size = integerInRange(a.limit, 20, 1, 100)
      const filtered = hasFilters(a) || Boolean(a.topic_id)
      const page = await api.get('/resource/note/list', {
        ...(filtered ? { page_size: size } : { limit: size }),
        cursor: a.cursor,
        topic_id: a.topic_id,
        ...filterQuery(a),
      }, signal)
      return filtered ? page : trimPage(page, size!)
    },
  })

  // ---- Reading notes -------------------------------------------------------

  tool({
    name: 'getnote_get_note',
    description: 'Get one note in full by its string ID, including its tags (with tag IDs). For very long notes use getnote_note_outline and getnote_note_section instead.',
    parameters: { note_id: noteId },
    readOnly: true,
    run: (a, signal) => api.get('/resource/note/detail', { id: a.note_id }, signal),
  })

  tool({
    name: 'getnote_note_outline',
    description: 'Read the outline of a long note: headings with UTF-16 offsets and a version. Use it before getnote_note_section.',
    parameters: { note_id: noteId },
    readOnly: true,
    run: (a, signal) => api.get('/resource/note/outline', { id: a.note_id }, signal),
  })

  tool({
    name: 'getnote_note_section',
    description: 'Read part of a long note, at an offset returned by getnote_note_outline or around literal keywords. Never compute offsets yourself; if the version changed, read the outline again.',
    parameters: {
      note_id: noteId,
      keyword: { type: 'string', description: 'Literal keyword(s), alternatives separated by |. Not semantic search.' },
      offset: { type: 'integer', description: 'UTF-16 offset returned by the outline or a previous section.' },
      limit: { type: 'integer', description: 'UTF-16 units to read (or keyword search window), 1-30000. Default 8000.' },
      version: { type: 'string', description: 'Version returned by the outline.' },
    },
    readOnly: true,
    run: (a, signal) => api.get('/resource/note/section', {
      id: a.note_id,
      keyword: a.keyword,
      offset: integerInRange(a.offset, undefined, 0, 3_000_000),
      limit: integerInRange(a.limit, undefined, 1, 30_000),
      version: a.version,
    }, signal),
  })

  tool({
    name: 'getnote_read_notes',
    description: 'Read several notes at once within a character budget. Notes that do not fit are listed in pending_ids; read them in a follow-up call.',
    parameters: {
      note_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Note IDs (strings), 1-20.' },
      fields: { type: 'array', items: { type: 'string', enum: ['content', 'ref_content', 'reference', 'original'] }, description: 'Fields to return; original (transcript/original text) is opt-in.' },
      max_total_chars: { type: 'integer', description: 'Total character budget, 1-64000 (server default 32000).' },
    },
    readOnly: true,
    run: (a, signal) => api.post('/resource/note/batch-detail', {
      ids: ids(a.note_ids, 'note_ids', 20),
      ...(a.fields && a.fields.length > 0 ? { fields: a.fields } : {}),
      ...(a.max_total_chars !== undefined ? { max_total_chars: integerInRange(a.max_total_chars, undefined, 1, 64_000) } : {}),
    }, signal),
  })

  tool({
    name: 'getnote_task_status',
    description: 'Check an asynchronous save task (e.g. a saved link) and get the resulting note ID.',
    parameters: { task_id: { type: 'string', required: true, description: 'task_id returned by getnote_save.' } },
    readOnly: true,
    run: (a, signal) => api.post('/resource/note/task/progress', { task_id: a.task_id }, signal),
  })

  // ---- Writing notes -------------------------------------------------------

  tool({
    name: 'getnote_save',
    description: 'Save a text note, a web link (processed asynchronously; check getnote_task_status), or images by HTTPS URL. Local image files are not supported.',
    parameters: {
      content: { type: 'string', description: 'Note text, or a single http(s) URL to save as a link note.' },
      image_urls: { type: 'array', items: { type: 'string' }, description: 'HTTPS image URLs to save as an image note.' },
      title: { type: 'string', description: 'Optional title.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      topic_id: { type: 'string', description: 'Save directly into this knowledge base.' },
      parent_id: { type: 'string', description: 'Create as a child note of this note.' },
      idempotency_key: { type: 'string', description: 'Reuse the same key (1-128 ASCII chars) when retrying the same save to avoid duplicates.' },
    },
    async run(a, signal) {
      const content = a.content?.trim() ?? ''
      const images = (a.image_urls ?? []).map(u => u.trim()).filter(Boolean)
      let body: Record<string, unknown>
      if (images.length > 0) {
        if (images.some(u => !/^https:\/\//i.test(u))) throw new RangeError('image_urls must be https URLs')
        body = { note_type: 'img_text', image_urls: images, ...(content ? { content } : {}) }
      } else if (URL_PATTERN.test(content)) {
        body = { note_type: 'link', link_url: content }
      } else if (content) {
        body = { note_type: 'plain_text', content: a.content }
      } else {
        throw new RangeError('provide content or image_urls')
      }
      if (a.idempotency_key !== undefined && !/^[\x21-\x7e]{1,128}$/.test(a.idempotency_key)) {
        throw new RangeError('idempotency_key must be 1-128 printable ASCII characters')
      }
      return await api.post('/resource/note/save', {
        ...body,
        title: a.title || undefined,
        tags: a.tags && a.tags.length > 0 ? a.tags : undefined,
        topic_id: a.topic_id || undefined,
        parent_id: a.parent_id || undefined,
        client_request_id: a.idempotency_key || undefined,
      }, signal)
    },
  })

  tool({
    name: 'getnote_update_note',
    description: 'Update a note\'s title, body (plain-text notes only), or full tag list. Replacing the body or all tags requires user confirmation.',
    parameters: {
      note_id: noteId,
      title: { type: 'string', description: 'New title.' },
      content: { type: 'string', description: 'New full body; replaces the existing body. Plain-text notes only.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'New complete tag list; replaces all existing tags.' },
    },
    async run(a, signal) {
      if (a.title === undefined && a.content === undefined && a.tags === undefined) {
        throw new RangeError('provide title, content, or tags')
      }
      return await api.post('/resource/note/update', {
        id: a.note_id,
        ...(a.title !== undefined ? { title: a.title } : {}),
        ...(a.content !== undefined ? { content: a.content } : {}),
        ...(a.tags !== undefined ? { tags: a.tags } : {}),
      }, signal)
    },
  })

  tool({
    name: 'getnote_add_note_tags',
    description: 'Add tags to a note, keeping its existing tags.',
    parameters: {
      note_id: noteId,
      tags: { type: 'array', required: true, items: { type: 'string' }, description: 'Tag names to add.' },
    },
    async run(a, signal) {
      const tags = [...new Set(a.tags.map(t => t.trim()).filter(Boolean))]
      if (tags.length === 0) throw new RangeError('tags must not be empty')
      return await api.post('/resource/note/tags/add', { note_id: a.note_id, tags }, signal)
    },
  })

  tool({
    name: 'getnote_remove_note_tag',
    description: 'Remove one tag from a note by tag ID (from getnote_get_note).',
    parameters: {
      note_id: noteId,
      tag_id: { type: 'string', required: true, description: 'Tag ID.' },
    },
    run: (a, signal) => api.post('/resource/note/tags/delete', { note_id: a.note_id, tag_id: a.tag_id }, signal),
  })

  tool({
    name: 'getnote_delete_note',
    description: 'Move a note to the recycle bin (restorable in the GetNote App). Requires user confirmation.',
    parameters: { note_id: noteId },
    run: (a, signal) => api.post('/resource/note/delete', { note_id: a.note_id }, signal),
  })

  tool({
    name: 'getnote_share_note',
    description: 'Make a note public and return its share link; anyone with the link can read it. Requires user confirmation.',
    parameters: {
      note_id: noteId,
      exclude_audio: { type: 'boolean', description: 'Do not include the audio in the shared note.' },
    },
    run: (a, signal) => api.post('/resource/note/sharing', { note_id: a.note_id, share_exclude_audio: Boolean(a.exclude_audio) }, signal),
  })

  // ---- Knowledge bases -----------------------------------------------------

  tool({
    name: 'getnote_list_knowledge_bases',
    description: 'List the user\'s own knowledge bases, or the ones the user subscribes to.',
    parameters: {
      subscribed: { type: 'boolean', description: 'List subscribed knowledge bases instead of the user\'s own.' },
      scope: { type: 'string', enum: ['DEFAULT', 'CUSTOMER', 'BOOKSPACE', 'TEAMSPACE'], description: 'Knowledge base type. Default DEFAULT.' },
      page: { type: 'integer', description: 'Page number, starting from 1.' },
    },
    readOnly: true,
    run: (a, signal) => api.get(a.subscribed ? '/resource/knowledge/subscribe/list' : '/resource/knowledge/list', {
      page: integerInRange(a.page, 1, 1, 100_000),
      scope: a.scope ?? 'DEFAULT',
    }, signal),
  })

  tool({
    name: 'getnote_list_kb_notes',
    description: 'List the notes in one knowledge base, with optional filters.',
    parameters: {
      topic_id: topicId,
      page: { type: 'integer', description: 'Page number, starting from 1.' },
      page_size: { type: 'integer', description: 'Notes per page, 1-100.' },
      ...noteFilters,
    },
    readOnly: true,
    run: (a, signal) => api.get('/resource/knowledge/notes', {
      topic_id: a.topic_id,
      page: integerInRange(a.page, 1, 1, 100_000),
      page_size: integerInRange(a.page_size, undefined, 1, 100),
      ...filterQuery(a),
    }, signal),
  })

  tool({
    name: 'getnote_kb_add_notes',
    description: 'Add notes to a knowledge base. At most 20 per call.',
    parameters: {
      topic_id: topicId,
      note_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Note IDs (strings), 1-20.' },
    },
    run: (a, signal) => api.post('/resource/knowledge/note/batch-add', { topic_id: a.topic_id, note_ids: ids(a.note_ids, 'note_ids', 20) }, signal),
  })

  tool({
    name: 'getnote_kb_remove_notes',
    description: 'Remove notes from a knowledge base; the notes themselves are kept. At most 20 per call. Requires user confirmation.',
    parameters: {
      topic_id: topicId,
      note_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Note IDs (strings), 1-20.' },
    },
    run: (a, signal) => api.post('/resource/knowledge/note/remove', { topic_id: a.topic_id, note_ids: ids(a.note_ids, 'note_ids', 20) }, signal),
  })
}

export {
  apiBase,
  parseJson,
  CredentialStore,
  DEFAULT_API_URL,
  DeviceLogin,
  DSH_CLIENT_ID,
  GetnoteApi,
  GetnoteApiError,
  MEMBERSHIP_URL,
  NotLoggedInError,
} from './api.js'
