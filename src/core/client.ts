import { chmodSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_DIR = join(homedir(), '.config', 'bridgerton')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

type Config = Record<string, unknown> & {
  api_key?: string
  stripe_api_key?: string
  format?: string
}

function readConfig(): Config {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}

/** Write a key-value pair to the config file. */
export function writeConfig(data: Record<string, unknown>) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  chmodSync(CONFIG_DIR, 0o700)
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...data }, null, 2) + '\n', { mode: 0o600 })
  chmodSync(CONFIG_FILE, 0o600)
}

/** Resolve the API key: env var takes precedence, then config file. */
export function getApiKey(): string {
  return process.env.BRIDGE_API_KEY ?? readConfig().api_key ?? ''
}

/** Resolve the Stripe API key: env vars take precedence, then config file. */
export function getStripeApiKey(): string {
  return process.env.STRIPE_SECRET_KEY ?? process.env.STRIPE_API_KEY ?? readConfig().stripe_api_key ?? ''
}

/** Get the saved default output format. */
export function getDefaultFormat(): string | undefined {
  return readConfig().format
}

/** Mask a secret for configuration output. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '***'
  if (secret.length <= 16) return secret.slice(0, 4) + '...' + secret.slice(-4)
  return secret.slice(0, 12) + '...' + secret.slice(-4)
}

/** Base URL for the Bridge API, auto-detected from API key prefix. */
const base = () =>
  getApiKey().startsWith('sk-test')
    ? 'https://api.sandbox.bridge.xyz/v0'
    : 'https://api.bridge.xyz/v0'

/** Returns the full URL for a Bridge API path. */
export const url = (path: string) => `${base()}${path}`

async function parseResponse(res: Response) {
  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) return res.json()

  return {
    content_type: contentType || null,
    content_disposition: res.headers.get('content-disposition'),
    body_omitted: true,
  }
}

function request(method: string, path: string, body?: Record<string, unknown>, opts?: { skipIdempotency?: boolean }) {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('No Bridge API key configured. Run: bridgerton configure api-key <key>')
  const h: Record<string, string> = {
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
  }
  if ((method === 'POST' || method === 'PUT') && !opts?.skipIdempotency)
    h['Idempotency-Key'] = crypto.randomUUID()

  return fetch(url(path), {
    method,
    headers: h,
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(parseResponse)
}

async function requestBinary(method: string, path: string, body?: Record<string, unknown>) {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('No Bridge API key configured. Run: bridgerton configure api-key <key>')
  const h: Record<string, string> = {
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
  }
  if (method === 'POST' || method === 'PUT') h['Idempotency-Key'] = crypto.randomUUID()

  const res = await fetch(url(path), {
    method,
    headers: h,
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return {
    contentType: res.headers.get('content-type'),
    contentDisposition: res.headers.get('content-disposition'),
    body: Buffer.from(await res.arrayBuffer()),
  }
}

/** Thin fetch wrapper for the Bridge.xyz API. */
export const bridge = {
  /** GET a Bridge API endpoint, with optional query params. */
  get: (path: string, params?: Record<string, string>) => {
    const qs = params && Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    return request('GET', path + qs)
  },
  /** POST to a Bridge API endpoint. */
  post: (path: string, body?: Record<string, unknown>, opts?: { skipIdempotency?: boolean }) => request('POST', path, body, opts),
  /** POST to a Bridge API endpoint and return the raw response body. */
  downloadPost: (path: string, body?: Record<string, unknown>) => requestBinary('POST', path, body),
  /** PUT to a Bridge API endpoint. */
  put: (path: string, body: Record<string, unknown>) => request('PUT', path, body),
  /** DELETE a Bridge API endpoint. */
  delete: (path: string) => request('DELETE', path),
}
