import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

export interface RunGetnoteOptions {
  binaryPath?: string
  apiUrl?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputBytes?: number
  /** Text written to the CLI's stdin (used with `--stdin` for long note bodies). */
  input?: string
}

/** Minimum CLI version whose command set this plugin targets. */
export const MIN_CLI_VERSION = '1.10.0'

const OUTDATED_CLI_PATTERN = /unknown (command|flag|shorthand flag)/i

function withUpgradeHint(message: string): string {
  if (!OUTDATED_CLI_PATTERN.test(message)) return message
  return `${message}\n\nThis GetNote plugin needs getnote CLI >= ${MIN_CLI_VERSION}. `
    + 'Ask the user to run `getnote update` (or `npm i -g @getnote/cli@latest`) in a terminal.'
}

export class GetnoteCliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GetnoteCliError'
  }
}

export function resolveGetnoteBinary(): string {
  const packageJson = require.resolve('@getnote/cli/package.json')
  const binary = process.platform === 'win32' ? 'getnote.exe' : 'getnote'
  return join(dirname(packageJson), 'bin', binary)
}

interface GetnoteInvocation {
  command: string
  prefixArgs: string[]
}

export function resolveGetnoteFromPath(
  pathValue = process.env.PATH ?? '',
  pathExtValue = process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM',
): string | undefined {
  const extensions = process.platform === 'win32'
    ? pathExtValue.split(';').filter(Boolean)
    : ['']

  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `getnote${extension.toLowerCase()}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Continue searching the remaining PATH entries.
      }
    }
  }
}

function resolveGetnoteInvocation(binaryPath?: string): GetnoteInvocation {
  if (binaryPath) return { command: binaryPath, prefixArgs: [] }

  const pathBinary = resolveGetnoteFromPath()
  if (pathBinary) return { command: pathBinary, prefixArgs: [] }

  try {
    return { command: resolveGetnoteBinary(), prefixArgs: [] }
  } catch {
    return {
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      prefixArgs: ['--yes', '--package', `@getnote/cli@${MIN_CLI_VERSION}`, '--', 'getnote'],
    }
  }
}

export async function runGetnote(
  args: readonly string[],
  options: RunGetnoteOptions = {},
): Promise<unknown> {
  const invocation = resolveGetnoteInvocation(options.binaryPath)
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024
  const commandArgs = [...invocation.prefixArgs, ...args, '--output', 'json']

  return await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, commandArgs, {
      env: {
        ...process.env,
        ...(options.apiUrl ? { GETNOTE_API_URL: options.apiUrl } : {}),
      },
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      signal: options.signal,
    })

    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      callback()
    }

    const capture = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGTERM')
        finish(() => reject(new GetnoteCliError(
          `getnote output exceeded ${maxOutputBytes} bytes`,
          null,
          Buffer.concat(stderr).toString('utf8'),
        )))
        return
      }
      target.push(chunk)
    }

    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {
        // The CLI may exit before reading stdin; the exit code reports the failure.
      })
      child.stdin.end(options.input, 'utf8')
    }

    child.stdout!.on('data', (chunk: Buffer) => capture(stdout, chunk))
    child.stderr!.on('data', (chunk: Buffer) => capture(stderr, chunk))

    timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(() => reject(new GetnoteCliError(
        `getnote command timed out after ${timeoutMs} ms`,
        null,
        Buffer.concat(stderr).toString('utf8'),
      )))
    }, timeoutMs)

    child.on('error', (error) => {
      finish(() => reject(new GetnoteCliError(
        `failed to start getnote: ${error.message}`,
        null,
        Buffer.concat(stderr).toString('utf8'),
      )))
    })

    child.on('close', (code) => {
      finish(() => {
        const stdoutText = Buffer.concat(stdout).toString('utf8').trim()
        const stderrText = Buffer.concat(stderr).toString('utf8').trim()
        if (code !== 0) {
          reject(new GetnoteCliError(
            withUpgradeHint(stderrText || stdoutText || `getnote exited with code ${String(code)}`),
            code,
            stderrText,
          ))
          return
        }

        if (!stdoutText) {
          resolve(null)
          return
        }

        try {
          resolve(JSON.parse(stdoutText))
        } catch {
          // A few informational CLI commands (notably auth status in CLI 1.5)
          // still return plain text even when --output json is requested.
          resolve(stdoutText)
        }
      })
    })
  })
}
