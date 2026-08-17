import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

export interface RunGetnoteOptions {
  binaryPath?: string
  apiUrl?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxOutputBytes?: number
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

export async function runGetnote(
  args: readonly string[],
  options: RunGetnoteOptions = {},
): Promise<unknown> {
  const binaryPath = options.binaryPath ?? resolveGetnoteBinary()
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024
  const commandArgs = [...args, '--output', 'json']

  return await new Promise((resolve, reject) => {
    const child = spawn(binaryPath, commandArgs, {
      env: {
        ...process.env,
        ...(options.apiUrl ? { GETNOTE_API_URL: options.apiUrl } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
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

    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk))

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
            stderrText || stdoutText || `getnote exited with code ${String(code)}`,
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
