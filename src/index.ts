import type { Context } from '@deepseek-ai/cordis'
import { apply as applySkillFilesystem } from '@deepseek-ai/dsh-skill-filesystem'
import { defineTool } from '@deepseek-ai/dsh-tools'
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

function renderJson(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}

function runnerOptions(config: Config, signal?: AbortSignal): RunGetnoteOptions {
  return {
    binaryPath: config.binaryPath,
    apiUrl: config.apiUrl,
    timeoutMs: config.timeoutMs,
    maxOutputBytes: config.maxOutputBytes,
    signal,
  }
}

function textOutput() {
  return {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
  }
}

function integerInRange(value: number | undefined, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`value must be an integer between ${min} and ${max}`)
  }
  return resolved
}

export function apply(ctx: Context, config: Config) {
  applySkillFilesystem(ctx, {
    providerName: 'getnote',
    includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('../skills', import.meta.url)),
  })

  ctx.tools.register(defineTool({
    name: 'getnote_auth_status',
    description: 'Check whether the current user is authenticated with GetNote (得到大脑).',
    parameters: {},
    output: textOutput(),
    async execute(_args, exec) {
      await runGetnote(['auth', 'status'], runnerOptions(config, exec.signal))
      return 'Authenticated with GetNote.'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'getnote_search',
    description: 'Semantically search notes in GetNote, optionally within one knowledge base.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language search query.' },
      knowledge_base_id: { type: 'string', description: 'Optional knowledge base/topic ID.' },
      limit: { type: 'integer', default: 10, description: 'Maximum results, from 1 to 10.' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const limit = integerInRange(args.limit, 10, 1, 10)
      const cliArgs = ['search', args.query, '--limit', String(limit)]
      if (args.knowledge_base_id) cliArgs.push('--kb', args.knowledge_base_id)
      return renderJson(await runGetnote(cliArgs, runnerOptions(config, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'getnote_save',
    description: 'Save text, a URL, or a local image path as a note in GetNote.',
    parameters: {
      content: { type: 'string', required: true, description: 'Text, URL, or local image path to save.' },
      title: { type: 'string', description: 'Optional note title.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional note tags.' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const cliArgs = ['save', args.content]
      if (args.title) cliArgs.push('--title', args.title)
      for (const tag of args.tags ?? []) cliArgs.push('--tag', tag)
      return renderJson(await runGetnote(cliArgs, runnerOptions(config, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'getnote_list_notes',
    description: 'List recent notes from GetNote.',
    parameters: {
      limit: { type: 'integer', default: 20, description: 'Number of notes, from 1 to 100.' },
      since_id: { type: 'string', description: 'Optional pagination cursor note ID.' },
    },
    output: textOutput(),
    async execute(args, exec) {
      const limit = integerInRange(args.limit, 20, 1, 100)
      const cliArgs = ['notes', '--limit', String(limit)]
      if (args.since_id) cliArgs.push('--since-id', args.since_id)
      return renderJson(await runGetnote(cliArgs, runnerOptions(config, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'getnote_get_note',
    description: 'Get the complete details of one GetNote note by its string ID.',
    parameters: {
      note_id: { type: 'string', required: true, description: 'Note ID. Keep it as a string.' },
    },
    output: textOutput(),
    async execute(args, exec) {
      return renderJson(await runGetnote(['note', args.note_id], runnerOptions(config, exec.signal)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'getnote_list_knowledge_bases',
    description: 'List the current user\'s GetNote knowledge bases.',
    parameters: {},
    output: textOutput(),
    async execute(_args, exec) {
      return renderJson(await runGetnote(['kbs'], runnerOptions(config, exec.signal)))
    },
  }))
}

export { GetnoteCliError, resolveGetnoteBinary, runGetnote } from './cli-runner.js'
