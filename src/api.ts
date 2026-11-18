import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** OpenAPI client ID used by this plugin for authorization. */
export const DSH_CLIENT_ID = 'cli_35ca47aab229ebb0c4c4dd12'
export const DEFAULT_API_URL = 'https://openapi.biji.com'

export interface Credential {
  apiKey: string
  clientId: string
  expiresAt?: number
}

export class GetnoteApiError extends Error {
  constructor(
    message: string,
    readonly code?: string | number,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'GetnoteApiError'
  }
}

export class NotLoggedInError extends GetnoteApiError {
  constructor() {
    super('Not logged in to GetNote. Call getnote_login and ask the user to open the returned link.', 'not_logged_in')
    this.name = 'NotLoggedInError'
  }
}

export function defaultCredentialPath(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'getnote', 'credentials.json')
}

/** Normalize a base URL to the `/open/api/v1` prefix, accepting the same forms as the CLI. */
export function apiBase(url: string): string {
  let base = url.replace(/\/+$/, '')
  if (base.endsWith('/open/api/v1')) return base
  if (base.endsWith('/open')) return `${base}/api/v1`
  return `${base}/open/api/v1`
}

/** Credential file stored with 0600 permissions. The key never reaches the model. */
export class CredentialStore {
  constructor(readonly path: string) {}

  async load(): Promise<Credential | undefined> {
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as Partial<Credential>
      if (typeof data.apiKey !== 'string' || !data.apiKey || typeof data.clientId !== 'string' || !data.clientId) return undefined
      return { apiKey: data.apiKey, clientId: data.clientId, expiresAt: data.expiresAt }
    } catch {
      return undefined
    }
  }

  async save(credential: Credential): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(credential, null, 2), { mode: 0o600 })
    await chmod(tmp, 0o600)
    await rename(tmp, this.path)
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true })
  }
}

/**
 * Parse JSON while keeping integers beyond Number.MAX_SAFE_INTEGER as strings.
 * GetNote IDs are 64-bit; a plain JSON.parse would silently corrupt them.
 */
export function parseJson(text: string): unknown {
  let out = ''
  let last = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i + 1
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++
      const token = text.slice(i, j)
      if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) {
        out += `${text.slice(last, i)}"${token}"`
        last = j
      }
      i = j - 1
    }
  }
  return JSON.parse(last === 0 ? text : out + text.slice(last))
}

export interface ApiOptions {
  apiUrl: string
  clientId: string
  store: CredentialStore
  timeoutMs: number
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
}

type Query = Record<string, string | number | boolean | undefined | null>

interface Envelope {
  success?: boolean
  data?: unknown
  error?: { code?: string | number, message?: string, reason?: string } | null
  // Legacy console-style envelope
  h?: { c?: number, e?: string }
  c?: unknown
}

export class GetnoteApi {
  readonly base: string
  private readonly fetchImpl: typeof fetch

  constructor(readonly options: ApiOptions) {
    this.base = apiBase(options.apiUrl)
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Environment variables override the stored credential (useful for CI and testing). */
  async credential(): Promise<Credential | undefined> {
    const env = this.options.env ?? process.env
    if (env.GETNOTE_API_KEY) {
      return { apiKey: env.GETNOTE_API_KEY, clientId: env.GETNOTE_CLIENT_ID || this.options.clientId }
    }
    return await this.options.store.load()
  }

  async get(path: string, query: Query = {}, signal?: AbortSignal): Promise<unknown> {
    const qs = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      qs.set(key, String(value))
    }
    const suffix = qs.size > 0 ? `?${qs.toString()}` : ''
    return await this.request('GET', `${path}${suffix}`, undefined, signal)
  }

  async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    return await this.request('POST', path, body, signal)
  }

  /** Unauthenticated OAuth call (device code / token). Returns the raw parsed body. */
  async oauth(path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number, body: Envelope | string }> {
    const response = await this.fetchImpl(`${this.base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.signal(signal),
    })
    const text = await response.text()
    try {
      return { status: response.status, body: parseJson(text) as Envelope }
    } catch {
      return { status: response.status, body: text }
    }
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  private async request(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const credential = await this.credential()
    if (!credential) throw new NotLoggedInError()

    const response = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credential.apiKey}`,
        'X-Client-ID': credential.clientId,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: this.signal(signal),
    })
    const text = await response.text()
    let parsed: Envelope
    try {
      parsed = parseJson(text) as Envelope
    } catch {
      throw new GetnoteApiError(`GetNote API returned HTTP ${response.status}: ${text.slice(0, 300)}`, undefined, response.status)
    }

    if (parsed.success === true) return parsed.data ?? null
    if (parsed.h && parsed.h.c === 0) return parsed.c ?? null

    const code = parsed.error?.code ?? parsed.h?.c
    const message = parsed.error?.message ?? parsed.h?.e ?? `GetNote API request failed (HTTP ${response.status})`
    if (response.status === 401 || code === 10004 || code === 'unauthorized') {
      throw new GetnoteApiError(
        `${message}. The GetNote authorization is missing, expired, or revoked; call getnote_login to authorize again.`,
        code,
        response.status,
      )
    }
    throw new GetnoteApiError(String(message), code, response.status)
  }
}

export interface LoginStart {
  verificationUri: string
  userCode: string
  expiresIn: number
}

/**
 * RFC 8628-style device authorization against the GetNote OpenAPI. `start()`
 * returns the link immediately; polling continues in the background and stores
 * the credential once the user confirms in the browser.
 */
export class DeviceLogin {
  private pending?: { start: LoginStart, done: Promise<void>, controller: AbortController, error?: string }
  lastResult?: 'authorized' | 'rejected' | 'expired' | 'failed'
  lastError?: string

  constructor(
    private readonly api: GetnoteApi,
    private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void> = defaultSleep,
  ) {}

  get inProgress(): LoginStart | undefined {
    return this.pending?.start
  }

  async start(signal?: AbortSignal): Promise<LoginStart> {
    if (this.pending) return this.pending.start
    const clientId = this.api.options.clientId
    const { body } = await this.api.oauth('/oauth/device/code', { client_id: clientId }, signal)
    const data = typeof body === 'object' && body ? (body.data as Record<string, unknown> | undefined) : undefined
    if (!data || typeof data.code !== 'string' || typeof data.verification_uri !== 'string') {
      const message = typeof body === 'object' && body ? body.error?.message : String(body).slice(0, 200)
      throw new GetnoteApiError(`Could not start GetNote authorization: ${message ?? 'unexpected response'}`)
    }
    const start: LoginStart = {
      verificationUri: data.verification_uri,
      userCode: String(data.user_code ?? ''),
      expiresIn: Number(data.expires_in ?? 600),
    }
    const intervalMs = Math.max(1, Number(data.interval ?? 5)) * 1000
    const controller = new AbortController()
    this.lastResult = undefined
    this.lastError = undefined
    const done = this.poll(clientId, data.code, intervalMs, start.expiresIn * 1000, controller.signal)
      .finally(() => { this.pending = undefined })
    this.pending = { start, done, controller }
    return start
  }

  /** Wait for the current background login (tests and graceful shutdown). */
  async wait(): Promise<void> {
    await this.pending?.done
  }

  cancel(): void {
    this.pending?.controller.abort()
  }

  private async poll(clientId: string, code: string, intervalMs: number, ttlMs: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + ttlMs
    try {
      while (Date.now() < deadline) {
        await this.sleep(intervalMs, signal)
        let result: { status: number, body: Envelope | string }
        try {
          result = await this.api.oauth('/oauth/token', { grant_type: 'device_code', client_id: clientId, code }, signal)
        } catch {
          if (signal.aborted) return
          continue
        }
        const raw = typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
        if (raw.includes('authorization_pending') || raw.includes('slow_down')) continue
        if (raw.includes('rejected')) { this.lastResult = 'rejected'; return }
        if (raw.includes('expired_token') || raw.includes('already_consumed')) { this.lastResult = 'expired'; return }
        const data = typeof result.body === 'object' ? (result.body.data as Record<string, unknown> | undefined) : undefined
        if (typeof result.body === 'object' && result.body.success && data && typeof data.api_key === 'string' && data.api_key) {
          await this.api.options.store.save({
            apiKey: data.api_key,
            clientId: typeof data.client_id === 'string' && data.client_id ? data.client_id : clientId,
            expiresAt: typeof data.expires_at === 'number' ? data.expires_at : undefined,
          })
          this.lastResult = 'authorized'
          return
        }
      }
      this.lastResult = 'expired'
    } catch (error) {
      if (signal.aborted) return
      this.lastResult = 'failed'
      this.lastError = error instanceof Error ? error.message : String(error)
    }
  }
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}
