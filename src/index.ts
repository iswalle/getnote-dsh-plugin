import type { Context } from '@deepseek-ai/cordis'
import { apply as applySkillFilesystem } from '@deepseek-ai/dsh-skill-filesystem'
import { defineTool, type InferArgs, type ParameterSchemaSpec } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { fileURLToPath } from 'node:url'
import { runGetnote, type RunGetnoteOptions } from './cli-runner.js'

export const name = 'getnote-tools'
export const inject = ['tools', 'skills']

export interface Config {
  binaryPath?: string
  apiUrl?: string
  timeoutMs: number
  maxOutputBytes: number
}

export const Config: Schema<Config> = Schema.object({
  binaryPath: Schema.string().description('Optional absolute path to the getnote executable.'),
  apiUrl: Schema.string().description('Optional GetNote OpenAPI base URL for explicit integration testing.'),
  timeoutMs: Schema.number().min(1_000).default(120_000),
  maxOutputBytes: Schema.number().min(1_024).default(10 * 1024 * 1024),
})

/** Text longer than this is sent through stdin (`--stdin`) instead of argv. */
export const STDIN_THRESHOLD = 2_000

function renderJson(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function runnerOptions(config: Config, signal?: AbortSignal, input?: string): RunGetnoteOptions {
  return {
    binaryPath: config.binaryPath,
    apiUrl: config.apiUrl,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    signal,
    input,
  }
}

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }
}

export function integerInRange(value: number | undefined, fallback: number | undefined, min: number, max: number): number | undefined {
  const resolved = value ?? fallback
  if (resolved === undefined) return undefined
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`value must be an integer between ${min} and ${max}`)
  }
  return resolved
}

/** Append `--flag value` when the value is present (numbers are stringified). */
function flag(args: string[], name: string, value: string | number | undefined | null) {
  if (value === undefined || value === null || value === '') return
  args.push(name, String(value))
}

function requireNonEmpty(values: readonly string[] | undefined, label: string, max: number): string[] {
  const list = (values ?? []).map(v => v.trim()).filter(Boolean)
  if (list.length === 0) throw new RangeError(`${label} must contain at least one ID`)
  if (list.length > max) throw new RangeError(`${label} accepts at most ${max} IDs`)
  return list
}

interface Invocation {
  args: string[]
  input?: string
}

// ---------------------------------------------------------------------------
// Shared parameter specs
// ---------------------------------------------------------------------------

const noteId = { type: 'string', required: true, description: 'Note ID. Always keep it as a string.' } as const
const topicId = { type: 'string', required: true, description: 'Knowledge base ID (topic_id), e.g. from getnote_list_knowledge_bases.' } as const
const page = { type: 'integer', description: 'Page number, starting from 1.' } as const

const NOTE_TYPES = [
  'plain_text', 'link', 'img_text', 'ref', 'audio', 'local_audio', 'class_audio',
  'meeting', 'internal_record', 'recorder_audio', 'recorder_flash_audio',
] as const

/** Filters shared by `notes` and `kb <topic_id>`. */
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

function pushNoteFilters(args: string[], a: {
  note_type?: string, source?: string,
  created_from?: string, created_to?: string, edited_from?: string, edited_to?: string,
}) {
  flag(args, '--note-type', a.note_type)
  flag(args, '--source', a.source)
  flag(args, '--created-from', a.created_from)
  flag(args, '--created-to', a.created_to)
  flag(args, '--edited-from', a.edited_from)
  flag(args, '--edited-to', a.edited_to)
}

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
    case 'getnote_kb_delete_directory':
      return `删除知识库 ${String(a.topic_id)} 的目录 ${String(a.directory_id)}`
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx: Context, config: Config) {
  applySkillFilesystem(ctx, {
    providerName: 'getnote',
    includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('../skills', import.meta.url)),
  })

  function cliTool<const S extends ParameterSchemaSpec>(def: {
    name: string
    description: string
    parameters: S
    readOnly?: boolean
    build(args: InferArgs<S>): string[] | Invocation
  }) {
    ctx.tools.register(defineTool({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: textOutput(),
      ...(def.readOnly ? { isConcurrencySafe: () => true } : {}),
      async execute(args, exec) {
        const built = def.build(args)
        const invocation = Array.isArray(built) ? { args: built } : built
        return renderJson(await runGetnote(
          invocation.args,
          runnerOptions(config, exec.signal, invocation.input),
        ))
      },
    }))
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const reason = confirmationReason(exec.name, exec.arguments)
    if (reason) return { kind: 'ask', reason }
    return next()
  })

  // ---- Connection & account ------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'getnote_auth_status',
    description: 'Check whether the current user is authenticated with GetNote (得到大脑).',
    parameters: {},
    output: textOutput(),
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      await runGetnote(['auth', 'status'], runnerOptions(config, exec.signal))
      return 'Authenticated with GetNote.'
    },
  }))

  cliTool({
    name: 'getnote_quota',
    description: 'Show the user\'s GetNote API quota and remaining usage.',
    parameters: {},
    readOnly: true,
    build: () => ['quota'],
  })

  // ---- Search & listing ----------------------------------------------------

  cliTool({
    name: 'getnote_search',
    description: 'Semantically search notes in GetNote, optionally within one knowledge base.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language search query.' },
      knowledge_base_id: { type: 'string', description: 'Optional knowledge base/topic ID.' },
      limit: { type: 'integer', default: 10, description: 'Maximum results, from 1 to 10.' },
      snippet_chars: { type: 'integer', description: 'Return short snippets of at most this many characters (100-1000) instead of full bodies. Use it to keep results compact.' },
    },
    readOnly: true,
    build(a) {
      const args = ['search', a.query, '--limit', String(integerInRange(a.limit, 10, 1, 10))]
      flag(args, '--kb', a.knowledge_base_id)
      const snippet = integerInRange(a.snippet_chars, undefined, 100, 1000)
      if (snippet !== undefined) args.push('--response-mode', 'snippet', '--max-snippet-chars', String(snippet))
      return args
    },
  })

  cliTool({
    name: 'getnote_list_notes',
    description: 'List the user\'s notes, newest first, with optional filters. Paginate with the returned cursor.',
    parameters: {
      limit: { type: 'integer', default: 20, description: 'Number of notes, from 1 to 100.' },
      cursor: { type: 'string', description: 'Pagination cursor returned by the previous page.' },
      since_id: { type: 'string', description: 'Deprecated alias of cursor.' },
      topic_id: { type: 'string', description: 'Only notes in this knowledge base.' },
      ...noteFilters,
    },
    readOnly: true,
    build(a) {
      const args = ['notes', '--limit', String(integerInRange(a.limit, 20, 1, 100))]
      flag(args, '--cursor', a.cursor ?? a.since_id)
      flag(args, '--topic-id', a.topic_id)
      pushNoteFilters(args, a)
      return args
    },
  })

  cliTool({
    name: 'getnote_find_course',
    description: 'Find 得到 courses that have the user\'s notes, by course name or exact teacher name. Use the returned course ID with getnote_list_notes (source=dedao).',
    parameters: {
      query: { type: 'string', description: 'Course name. Provide query or teacher.' },
      teacher: { type: 'string', description: 'Exact teacher name.' },
      match_mode: { type: 'string', enum: ['exact', 'prefix'], default: 'exact', description: 'How to match the course name.' },
      cursor: { type: 'string', description: 'Continuation cursor from the previous page; keep the same query.' },
    },
    readOnly: true,
    build(a) {
      if (!a.query && !a.teacher) throw new RangeError('provide query or teacher')
      const args = ['references', 'list', '--source', 'dedao', '--resource-type', 'course']
      flag(args, '--query', a.query)
      flag(args, '--author', a.teacher)
      flag(args, '--match-mode', a.match_mode)
      flag(args, '--cursor', a.cursor)
      return args
    },
  })

  // ---- Reading notes -------------------------------------------------------

  cliTool({
    name: 'getnote_get_note',
    description: 'Get the complete details of one GetNote note by its string ID. For very long notes prefer getnote_note_outline + getnote_note_section.',
    parameters: { note_id: noteId },
    readOnly: true,
    build: a => ['note', a.note_id],
  })

  cliTool({
    name: 'getnote_read_notes',
    description: 'Read the bodies of several personal notes at once within a character budget. Items that do not fit are deferred and listed for a follow-up call.',
    parameters: {
      note_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Note IDs (strings), up to 200; at most 20 distinct notes are returned per call.' },
      fields: { type: 'array', items: { type: 'string', enum: ['content', 'ref_content', 'reference', 'original'] }, description: 'Fields to return. original (raw transcript/original text) is opt-in.' },
      max_total_chars: { type: 'integer', description: 'Total character budget, 1-64000 (server default 32000).' },
    },
    readOnly: true,
    build(a) {
      const args = ['notes', 'batch', ...requireNonEmpty(a.note_ids, 'note_ids', 200)]
      if (a.fields && a.fields.length > 0) args.push('--fields', a.fields.join(','))
      flag(args, '--max-total-chars', integerInRange(a.max_total_chars, undefined, 1, 64_000))
      return args
    },
  })

  cliTool({
    name: 'getnote_note_outline',
    description: 'Read the outline (headings with UTF-16 offsets and a version) of a long note. Use it before getnote_note_section.',
    parameters: { note_id: noteId },
    readOnly: true,
    build: a => ['note', 'outline', a.note_id],
  })

  cliTool({
    name: 'getnote_note_section',
    description: 'Read part of a long note, either at an offset returned by getnote_note_outline or around literal keywords. Never compute offsets yourself.',
    parameters: {
      note_id: noteId,
      keyword: { type: 'string', description: 'Literal keyword(s), alternatives separated by |. Not semantic search.' },
      offset: { type: 'integer', description: 'UTF-16 offset returned by the outline or a previous section.' },
      limit: { type: 'integer', description: 'UTF-16 units to read (or keyword search window), 1-30000. Default 8000.' },
      version: { type: 'string', description: 'Version returned by the outline; if it changed, re-read the outline.' },
    },
    readOnly: true,
    build(a) {
      const args = ['note', 'section', a.note_id]
      flag(args, '--keyword', a.keyword)
      flag(args, '--offset', integerInRange(a.offset, undefined, 0, Number.MAX_SAFE_INTEGER))
      flag(args, '--limit', integerInRange(a.limit, undefined, 1, 30_000))
      flag(args, '--version', a.version)
      return args
    },
  })

  const NOTE_VIEWS = ['original', 'transcript', 'attachments', 'timeline', 'chapters', 'quick-note', 'todos'] as const
  cliTool({
    name: 'getnote_note_view',
    description: 'Read a specific view of a note: original=原文, transcript=录音转写, attachments=附件, timeline=时间线, chapters=章节时间线, quick-note=快捷笔记, todos=会议待办.',
    parameters: {
      note_id: noteId,
      view: { type: 'string', required: true, enum: NOTE_VIEWS, description: 'Which view to read.' },
    },
    readOnly: true,
    build: a => ['note', a.view, a.note_id],
  })

  cliTool({
    name: 'getnote_task_status',
    description: 'Check the progress of an asynchronous save task (e.g. a saved link) and get the resulting note ID.',
    parameters: { task_id: { type: 'string', required: true, description: 'Task ID returned by getnote_save.' } },
    readOnly: true,
    build: a => ['task', a.task_id],
  })

  cliTool({
    name: 'getnote_note_marks',
    description: 'Read the highlights/marks (标记) of a note.',
    parameters: { note_id: noteId },
    readOnly: true,
    build: a => ['marks', a.note_id],
  })

  cliTool({
    name: 'getnote_list_sprouts',
    description: 'List the user\'s 发芽 (sprout) reports for one month.',
    parameters: {
      month: { type: 'string', required: true, description: 'Month in YYYY-MM format, e.g. 2026-11.' },
      limit: { type: 'integer', default: 20, description: 'Items per page, 1-20.' },
      cursor: { type: 'string', description: 'Cursor returned by the previous page.' },
    },
    readOnly: true,
    build(a) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(a.month)) throw new RangeError('month must be YYYY-MM')
      const args = ['sprouts', a.month, '--limit', String(integerInRange(a.limit, 20, 1, 20))]
      flag(args, '--since-id', a.cursor)
      return args
    },
  })

  cliTool({
    name: 'getnote_get_sprout',
    description: 'Read one 发芽 (sprout) report.',
    parameters: { sprout_id: { type: 'string', required: true, description: 'Sprout report ID.' } },
    readOnly: true,
    build: a => ['sprout', a.sprout_id],
  })

  // ---- Writing notes -------------------------------------------------------

  cliTool({
    name: 'getnote_save',
    description: 'Save text, a URL, or a local image path as a note in GetNote, optionally into a knowledge base or as a child note.',
    parameters: {
      content: { type: 'string', required: true, description: 'Text, URL, or local image path to save.' },
      title: { type: 'string', description: 'Optional note title.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional note tags.' },
      topic_id: { type: 'string', description: 'Save directly into this knowledge base.' },
      parent_id: { type: 'string', description: 'Create as a child note of this note.' },
      idempotency_key: { type: 'string', description: 'Reuse the same key when retrying the same save (1-128 ASCII chars) to avoid duplicates.' },
    },
    build(a) {
      const longText = a.content.length > STDIN_THRESHOLD
      const args = longText ? ['save', '--stdin'] : ['save', a.content]
      flag(args, '--title', a.title)
      for (const tag of a.tags ?? []) args.push('--tag', tag)
      flag(args, '--topic-id', a.topic_id)
      flag(args, '--parent-id', a.parent_id)
      flag(args, '--idempotency-key', a.idempotency_key)
      return longText ? { args, input: a.content } : args
    },
  })

  cliTool({
    name: 'getnote_update_note',
    description: 'Update a note\'s title, body (plain-text notes only), or tags. Replacing the body or the tags requires user confirmation.',
    parameters: {
      note_id: noteId,
      title: { type: 'string', description: 'New title.' },
      content: { type: 'string', description: 'New full body; replaces the existing body. Plain-text notes only.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'New complete tag list; replaces all existing tags.' },
    },
    build(a) {
      if (a.title === undefined && a.content === undefined && a.tags === undefined) {
        throw new RangeError('provide title, content, or tags')
      }
      const args = ['note', 'update', a.note_id]
      flag(args, '--title', a.title)
      if (a.content !== undefined) args.push('--content', a.content)
      if (a.tags !== undefined) args.push('--tag', a.tags.join(','))
      // Confirmed by the DSH approval gate (see confirmationReason).
      if (a.content !== undefined || a.tags !== undefined) args.push('--yes')
      return args
    },
  })

  cliTool({
    name: 'getnote_delete_note',
    description: 'Move a note to the recycle bin (restorable in the App). Requires user confirmation.',
    parameters: { note_id: noteId },
    build: a => ['note', 'delete', a.note_id, '--yes'],
  })

  cliTool({
    name: 'getnote_share_note',
    description: 'Make a note public and return its share link; anyone with the link can read it. Requires user confirmation.',
    parameters: {
      note_id: noteId,
      exclude_audio: { type: 'boolean', description: 'Do not include the audio in the shared note.' },
    },
    build(a) {
      const args = ['note', 'share', a.note_id]
      if (a.exclude_audio) args.push('--exclude-audio')
      args.push('--yes')
      return args
    },
  })

  // ---- Tags ---------------------------------------------------------------

  cliTool({
    name: 'getnote_list_note_tags',
    description: 'List the tags (with tag IDs) on one note.',
    parameters: { note_id: noteId },
    readOnly: true,
    build: a => ['tag', 'list', a.note_id],
  })

  cliTool({
    name: 'getnote_add_note_tag',
    description: 'Add one tag to a note, keeping existing tags.',
    parameters: { note_id: noteId, tag: { type: 'string', required: true, description: 'Tag name.' } },
    build: a => ['tag', 'add', a.note_id, a.tag],
  })

  cliTool({
    name: 'getnote_remove_note_tag',
    description: 'Remove one tag from a note by tag ID (get it from getnote_list_note_tags).',
    parameters: { note_id: noteId, tag_id: { type: 'string', required: true, description: 'Tag ID.' } },
    build: a => ['tag', 'remove', a.note_id, a.tag_id],
  })

  // ---- Knowledge bases ----------------------------------------------------

  cliTool({
    name: 'getnote_list_knowledge_bases',
    description: 'List the user\'s own GetNote knowledge bases, or the ones the user subscribes to.',
    parameters: {
      subscribed: { type: 'boolean', description: 'List subscribed knowledge bases instead of the user\'s own.' },
      scope: { type: 'string', enum: ['DEFAULT', 'CUSTOMER', 'BOOKSPACE', 'TEAMSPACE'], description: 'Knowledge base type. Default DEFAULT.' },
      query: { type: 'string', description: 'Match knowledge-base name or book title.' },
      author: { type: 'string', description: 'BOOKSPACE author keyword.' },
      book_id: { type: 'string', description: 'Exact BOOKSPACE book ID.' },
      page,
      page_size: { type: 'integer', description: 'Items per page, 1-100.' },
    },
    readOnly: true,
    build(a) {
      const args = [a.subscribed ? 'kbs-sub' : 'kbs']
      flag(args, '--scope', a.scope)
      flag(args, '--query', a.query)
      flag(args, '--author', a.author)
      flag(args, '--book-id', a.book_id)
      flag(args, '--page', integerInRange(a.page, undefined, 1, Number.MAX_SAFE_INTEGER))
      flag(args, '--page-size', integerInRange(a.page_size, undefined, 1, 100))
      return args
    },
  })

  cliTool({
    name: 'getnote_list_kb_notes',
    description: 'List the notes in one knowledge base, with optional filters.',
    parameters: {
      topic_id: topicId,
      page,
      page_size: { type: 'integer', description: 'Items per page, 1-100.' },
      ...noteFilters,
    },
    readOnly: true,
    build(a) {
      const args = ['kb', a.topic_id]
      flag(args, '--page', integerInRange(a.page, undefined, 1, Number.MAX_SAFE_INTEGER))
      flag(args, '--page-size', integerInRange(a.page_size, undefined, 1, 100))
      pushNoteFilters(args, a)
      return args
    },
  })

  cliTool({
    name: 'getnote_create_knowledge_base',
    description: 'Create a new knowledge base.',
    parameters: {
      name: { type: 'string', required: true, description: 'Knowledge base name.' },
      description: { type: 'string', description: 'Optional description.' },
    },
    build(a) {
      const args = ['kb', 'create', a.name]
      flag(args, '--desc', a.description)
      return args
    },
  })

  cliTool({
    name: 'getnote_kb_add_notes',
    description: 'Add notes to a knowledge base, optionally into a directory. At most 20 notes per call.',
    parameters: {
      topic_id: topicId,
      note_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Note IDs (strings), 1-20.' },
      directory_id: { type: 'string', description: 'Target directory ID; omit for the root.' },
    },
    build(a) {
      const args = ['kb', 'add', a.topic_id, ...requireNonEmpty(a.note_ids, 'note_ids', 20)]
      flag(args, '--directory-id', a.directory_id)
      return args
    },
  })

  cliTool({
    name: 'getnote_kb_remove_notes',
    description: 'Remove notes from a knowledge base (the notes themselves are kept). At most 20 per call. Requires user confirmation.',
    parameters: {
      topic_id: topicId,
      note_ids: { type: 'array', required: true, items: { type: 'string' }, description: 'Note IDs (strings), 1-20.' },
    },
    build: a => ['kb', 'remove', a.topic_id, ...requireNonEmpty(a.note_ids, 'note_ids', 20), '--yes'],
  })

  cliTool({
    name: 'getnote_kb_list_directories',
    description: 'Browse the directories and resources of a knowledge base.',
    parameters: {
      topic_id: topicId,
      directory_id: { type: 'string', description: 'Directory to browse; omit for the root.' },
    },
    readOnly: true,
    build(a) {
      const args = ['kb', 'directories', a.topic_id]
      flag(args, '--directory-id', a.directory_id)
      return args
    },
  })

  cliTool({
    name: 'getnote_kb_create_directory',
    description: 'Create a directory in a knowledge base.',
    parameters: {
      topic_id: topicId,
      name: { type: 'string', required: true, description: 'Directory name.' },
      parent_id: { type: 'string', description: 'Parent directory ID; omit for the root.' },
    },
    build(a) {
      const args = ['kb', 'directory-create', a.topic_id, '--name', a.name]
      flag(args, '--parent-id', a.parent_id)
      return args
    },
  })

  cliTool({
    name: 'getnote_kb_update_directory',
    description: 'Rename or move a directory in a knowledge base.',
    parameters: {
      topic_id: topicId,
      directory_id: { type: 'string', required: true, description: 'Directory ID.' },
      name: { type: 'string', description: 'New name; omit to keep it.' },
      parent_id: { type: 'string', description: 'New parent directory ID; omit to keep it.' },
    },
    build(a) {
      if (a.name === undefined && a.parent_id === undefined) throw new RangeError('provide name or parent_id')
      const args = ['kb', 'directory-update', a.topic_id, a.directory_id]
      flag(args, '--name', a.name)
      flag(args, '--parent-id', a.parent_id)
      return args
    },
  })

  cliTool({
    name: 'getnote_kb_delete_directory',
    description: 'Delete a directory from a knowledge base. Requires user confirmation.',
    parameters: {
      topic_id: topicId,
      directory_id: { type: 'string', required: true, description: 'Directory ID.' },
    },
    build: a => ['kb', 'directory-delete', a.topic_id, a.directory_id, '--yes'],
  })

  // ---- Knowledge-base subscriptions --------------------------------------

  cliTool({
    name: 'getnote_kb_list_bloggers',
    description: 'List the creators (博主) a knowledge base subscribes to.',
    parameters: { topic_id: topicId, page },
    readOnly: true,
    build(a) {
      const args = ['kb', 'bloggers', a.topic_id]
      flag(args, '--page', integerInRange(a.page, undefined, 1, Number.MAX_SAFE_INTEGER))
      return args
    },
  })

  cliTool({
    name: 'getnote_kb_list_blogger_contents',
    description: 'List the posts of one subscribed creator in a knowledge base.',
    parameters: {
      topic_id: topicId,
      follow_id: { type: 'string', required: true, description: 'Follow ID from getnote_kb_list_bloggers.' },
      page,
    },
    readOnly: true,
    build(a) {
      const args = ['kb', 'blogger-contents', a.topic_id, a.follow_id]
      flag(args, '--page', integerInRange(a.page, undefined, 1, Number.MAX_SAFE_INTEGER))
      return args
    },
  })

  cliTool({
    name: 'getnote_kb_get_blogger_content',
    description: 'Read one subscribed creator post, including its original text.',
    parameters: {
      topic_id: topicId,
      post_id: { type: 'string', required: true, description: 'Post ID from getnote_kb_list_blogger_contents.' },
    },
    readOnly: true,
    build: a => ['kb', 'blogger-content', a.topic_id, a.post_id],
  })

  cliTool({
    name: 'getnote_kb_follow_blogger',
    description: 'Subscribe a knowledge base to a creator (currently Douyin) by profile link.',
    parameters: {
      topic_id: topicId,
      link: { type: 'string', required: true, description: 'Creator profile link.' },
    },
    build: a => ['kb', 'blogger-follow', a.topic_id, a.link],
  })

  cliTool({
    name: 'getnote_kb_list_lives',
    description: 'List the live streams a knowledge base subscribes to.',
    parameters: { topic_id: topicId, page },
    readOnly: true,
    build(a) {
      const args = ['kb', 'lives', a.topic_id]
      flag(args, '--page', integerInRange(a.page, undefined, 1, Number.MAX_SAFE_INTEGER))
      return args
    },
  })

  cliTool({
    name: 'getnote_kb_get_live',
    description: 'Read one subscribed live stream and its content.',
    parameters: {
      topic_id: topicId,
      live_id: { type: 'string', required: true, description: 'Live ID from getnote_kb_list_lives.' },
    },
    readOnly: true,
    build: a => ['kb', 'live', a.topic_id, a.live_id],
  })

  cliTool({
    name: 'getnote_kb_follow_live',
    description: 'Subscribe a knowledge base to a live stream (currently 得到直播) by link.',
    parameters: {
      topic_id: topicId,
      link: { type: 'string', required: true, description: 'Live stream link.' },
    },
    build: a => ['kb', 'live-follow', a.topic_id, a.link],
  })
}

export {
  GetnoteCliError,
  MIN_CLI_VERSION,
  resolveGetnoteBinary,
  resolveGetnoteFromPath,
  runGetnote,
} from './cli-runner.js'
