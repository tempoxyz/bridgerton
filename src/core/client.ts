import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CONFIG_DIR = join(homedir(), '.config', 'bridgerton')
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')

function readConfig(): Record<string, string> {
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
}

/** Write a key-value pair to the config file. */
export function writeConfig(data: Record<string, string>) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...data }, null, 2) + '\n')
}

/** Resolve the API key: env var takes precedence, then config file. */
export function getApiKey(): string {
  return process.env.BRIDGE_API_KEY ?? readConfig().api_key ?? ''
}

/** Get the saved default output format. */
export function getDefaultFormat(): string | undefined {
  return readConfig().format
}

/** Base URL for the Bridge API, auto-detected from API key prefix. */
const base = () =>
  getApiKey().startsWith('sk-test')
    ? 'https://api.sandbox.bridge.xyz/v0'
    : 'https://api.bridge.xyz/v0'

/** Returns the full URL for a Bridge API path. */
export const url = (path: string) => `${base()}${path}`

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
  }).then(res => res.json())
}

/** Thin fetch wrapper for the Bridge.xyz API. */
export const bridge = {
  /** GET a Bridge API endpoint, with optional query params. */
  get: (path: string, params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return request('GET', path + qs)
  },
  /** POST to a Bridge API endpoint. */
  post: (path: string, body: Record<string, unknown>, opts?: { skipIdempotency?: boolean }) => request('POST', path, body, opts),
  /** PUT to a Bridge API endpoint. */
  put: (path: string, body: Record<string, unknown>) => request('PUT', path, body),
  /** DELETE a Bridge API endpoint. */
  delete: (path: string) => request('DELETE', path),
}
