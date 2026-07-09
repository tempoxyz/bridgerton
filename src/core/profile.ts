import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import ngrok from '@ngrok/ngrok'
import { createPublicClient, createWalletClient, http, stringToHex, type Address, type Chain, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum, base, mainnet, optimism, polygon } from 'viem/chains'
import { createClient } from 'viem/tempo'
import { getApiKey, url } from './client.js'

// --- constants ---

export const TEMPO_USDC_E_TOKEN_ADDRESS = '0x20c000000000000000000000b9537d11c60e8b50'
export const TEMPO_PATHUSD_TOKEN_ADDRESS = '0x20c0000000000000000000000000000000000000'
const ALL_WEBHOOK_EVENT_CATEGORIES = [
  'customer', 'kyc_link', 'liquidation_address.drain', 'static_memo.activity', 'transfer',
  'virtual_account.activity', 'bridge_wallet.activity', 'card_account', 'card_transaction',
  'card_withdrawal', 'posted_card_account_transaction', 'external_account',
]

// --- small helpers ---

const nowEpoch = () => Date.now() / 1000
const isoFromEpoch = (epoch: number) => new Date(epoch * 1000).toISOString()

function msDelta(start: number | null | undefined, end: number | null | undefined): number | null {
  if (start == null || end == null) return null
  return Math.round((end - start) * 1000 * 1000) / 1000
}

const safeKey = (s: string) => s.replace(/[^A-Za-z0-9_.-]+/g, '_')

function normalizeStatus(raw: string): string {
  const lower = (raw ?? '').toLowerCase()
  const compact = lower.replace(/[^a-z0-9]/g, '')
  if (compact === 'paymentsubmitted') return 'payment_submitted'
  if (compact === 'paymentprocessed') return 'payment_processed'
  return lower.replace(/-/g, '_')
}

/** Convert a decimal amount string to base units. */
export function amountToAtomics(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`Invalid amount: ${amount}`)
  const [whole, frac = ''] = amount.split('.')
  if (frac.length > decimals) throw new Error(`Amount ${amount} has more than ${decimals} decimal places`)
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}

/** Convert base units to a decimal amount string. */
export function atomicsToAmount(atoms: bigint, decimals: number): string {
  const s = atoms.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

const multiplyAmount = (amount: string, n: number, decimals: number) =>
  atomicsToAmount(amountToAtomics(amount, decimals) * BigInt(n), decimals)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const log = (...args: unknown[]) => console.error(...args)
const fmtSecs = (ms: number | null | undefined) => (ms == null ? '—' : `${(ms / 1000).toFixed(2)}s`)
const shortHash = (h: string) => (h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h)
const shortId = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id)

// --- status-aware Bridge API request (the shared client wrapper hides HTTP status) ---

type ApiResponse = {
  http_code: number
  body: string
  json: any
  error?: string | undefined
}

async function apiRequest(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<ApiResponse> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('No Bridge API key configured. Run: bridgerton configure api-key <key>')
  const headers: Record<string, string> = { 'Api-Key': apiKey, Accept: 'application/json' }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  try {
    const res = await fetch(url(path), {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* non-JSON body */ }
    return { http_code: res.status, body: text, json }
  } catch (err) {
    return { http_code: 0, body: '', json: null, error: String(err) }
  }
}

function requireApiSuccess(res: ApiResponse, action: string) {
  if (res.http_code >= 200 && res.http_code < 300) return
  throw new Error(`${action} failed (HTTP ${res.http_code}): ${res.error ?? res.body}`)
}

// --- webhook receiver ---

type WebhookRecord = {
  received_epoch: number
  received_iso: string
  /** 'webhook' when delivered to our endpoint; 'api_poll' when observed by polling the Bridge API. */
  source?: 'webhook' | 'api_poll'
  summary: {
    event_id: string
    event_object_id: string
    client_reference_id: string
    status: string
    normalized_status: string
    tx_hashes: string[]
    destination_tx_hash?: string
  }
  payload: any
}

function extractTxHashes(payload: any): string[] {
  const hashes = new Set<string>()
  const visit = (node: any) => {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (/tx_hash|txhash|transaction_hash|transactionhash/i.test(key) && typeof value === 'string') hashes.add(value)
        visit(value)
      }
    }
  }
  visit(payload)
  return [...hashes]
}

class WebhookReceiver {
  private server: Server
  private events = new Map<string, WebhookRecord>()
  private waiters = new Map<string, ((record: WebhookRecord) => void)[]>()
  recordCount = 0

  constructor(
    private jsonlPath: string,
    private verbose: boolean,
  ) {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"ok":true}')
        if (req.method === 'POST') this.process(Buffer.concat(chunks).toString('utf8'))
      })
    })
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, () => resolve())
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  private process(rawBody: string) {
    const receivedEpoch = nowEpoch()
    let payload: any
    try { payload = JSON.parse(rawBody) } catch {
      appendFileSync(this.jsonlPath, JSON.stringify({
        received_epoch: receivedEpoch,
        received_iso: isoFromEpoch(receivedEpoch),
        parse_error: 'invalid_json',
        raw_body: rawBody,
      }) + '\n')
      return
    }

    const eventId = payload.event_id ?? payload.id ?? ''
    const eventObjectId = payload.event_object_id ?? payload.event_object?.id ?? payload.data?.id ?? ''
    const clientReferenceId = payload.event_object?.client_reference_id ?? payload.data?.client_reference_id ?? ''
    const status = payload.event_object_status ?? payload.event_object?.state ?? payload.event_object?.status
      ?? payload.data?.state ?? payload.data?.status ?? ''
    const statusNorm = normalizeStatus(status)

    const destinationTxHash = payload.event_object?.receipt?.destination_tx_hash
      ?? payload.data?.receipt?.destination_tx_hash

    const record: WebhookRecord = {
      received_epoch: receivedEpoch,
      received_iso: isoFromEpoch(receivedEpoch),
      source: 'webhook',
      summary: {
        event_id: eventId,
        event_object_id: eventObjectId,
        client_reference_id: clientReferenceId,
        status,
        normalized_status: statusNorm,
        tx_hashes: extractTxHashes(payload),
        ...(typeof destinationTxHash === 'string' && destinationTxHash ? { destination_tx_hash: destinationTxHash } : {}),
      },
      payload,
    }

    this.recordCount += 1
    appendFileSync(this.jsonlPath, JSON.stringify(record) + '\n')

    if (statusNorm) {
      for (const key of [clientReferenceId, eventObjectId]) {
        if (!key) continue
        const mapKey = `${safeKey(key)}.${statusNorm}`
        if (!this.events.has(mapKey)) this.events.set(mapKey, record)
        for (const resolve of this.waiters.get(mapKey) ?? []) resolve(record)
        this.waiters.delete(mapKey)
      }
    }

    if (this.verbose) {
      log(`  · webhook ${statusNorm || status || '<no status>'} for ${eventObjectId || clientReferenceId || '<unknown object>'}`)
    }
  }

  readEvent(keys: (string | undefined)[], statusNorm: string): WebhookRecord | null {
    for (const key of keys) {
      if (!key) continue
      const record = this.events.get(`${safeKey(key)}.${statusNorm}`)
      if (record) return record
    }
    return null
  }

  waitForEvent(keys: (string | undefined)[], statusNorm: string, timeoutSeconds: number): Promise<WebhookRecord | null> {
    const existing = this.readEvent(keys, statusNorm)
    if (existing) return Promise.resolve(existing)

    return new Promise((resolve) => {
      const mapKeys = keys.filter((k): k is string => !!k).map((k) => `${safeKey(k)}.${statusNorm}`)
      let done = false
      const finish = (record: WebhookRecord | null) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(record)
      }
      const timer = setTimeout(() => finish(this.readEvent(keys, statusNorm)), timeoutSeconds * 1000)
      timer.unref?.()
      for (const mapKey of mapKeys) {
        const list = this.waiters.get(mapKey) ?? []
        list.push(finish)
        this.waiters.set(mapKey, list)
      }
    })
  }

  recentSummaries(n: number) {
    return [...this.events.values()].slice(-n).map((r) => r.summary)
  }
}

// --- ngrok tunnel (in-process via the @ngrok/ngrok SDK; no binary, no agent API) ---

function ngrokAuthtoken(): string | undefined {
  if (process.env.NGROK_AUTHTOKEN) return process.env.NGROK_AUTHTOKEN
  const configPaths = [
    join(homedir(), 'Library', 'Application Support', 'ngrok', 'ngrok.yml'),
    join(homedir(), '.config', 'ngrok', 'ngrok.yml'),
    join(homedir(), '.ngrok2', 'ngrok.yml'),
  ]
  for (const path of configPaths) {
    if (!existsSync(path)) continue
    const match = readFileSync(path, 'utf8').match(/^\s*authtoken:\s*(\S+)/m)
    if (match) return match[1]
  }
  return undefined
}

async function startTunnel(port: number, domain?: string): Promise<{ url: string; close: () => Promise<void> }> {
  log('  · starting ngrok tunnel…')
  const authtoken = ngrokAuthtoken()
  if (!authtoken) throw new Error('No ngrok authtoken found. Set NGROK_AUTHTOKEN or run: ngrok config add-authtoken <token>')
  const listener = await ngrok.forward({ addr: port, authtoken, ...(domain ? { domain } : {}) })
  const publicUrl = listener.url()
  if (!publicUrl) throw new Error('ngrok tunnel started but did not report a public URL')
  return { url: publicUrl, close: () => listener.close() }
}

// --- Bridge webhook endpoint management ---

type WebhookSetupOptions = {
  webhookId?: string | undefined
  recreate: boolean
  eventCategories: string
  eventEpoch: string
  webhookPath: string
}

function categoriesList(raw: string): string[] {
  const value = raw.trim().toLowerCase() === 'all' || raw.trim() === '*' ? ALL_WEBHOOK_EVENT_CATEGORIES.join(',') : raw
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

async function activateWebhookEndpoint(endpoint: any, publicWebhookUrl: string, opts: WebhookSetupOptions): Promise<string> {
  const webhookId = endpoint.id
  if (!webhookId) throw new Error('Bridge webhook response did not include an id')

  if (endpoint.url !== publicWebhookUrl && endpoint.status === 'active') {
    log(`  · disabling webhook ${webhookId} before changing its URL`)
    requireApiSuccess(await apiRequest('PUT', `/webhooks/${webhookId}`, { status: 'disabled' }), `Disabling Bridge webhook ${webhookId}`)
  }

  const payload: Record<string, unknown> = { status: 'active' }
  if (endpoint.url !== publicWebhookUrl) payload.url = publicWebhookUrl
  const categories = categoriesList(opts.eventCategories)
  if (categories.length) payload.event_categories = categories

  const res = await apiRequest('PUT', `/webhooks/${webhookId}`, payload)
  requireApiSuccess(res, `Activating Bridge webhook ${webhookId}`)
  log(`  ✓ Bridge webhook ${webhookId} ${res.json?.status ?? 'active'}`)
  return webhookId
}

async function createWebhookEndpoint(publicWebhookUrl: string, opts: WebhookSetupOptions): Promise<string> {
  const payload: Record<string, unknown> = { url: publicWebhookUrl, event_epoch: opts.eventEpoch }
  const categories = categoriesList(opts.eventCategories)
  if (categories.length) payload.event_categories = categories

  const res = await apiRequest('POST', '/webhooks', payload, crypto.randomUUID())
  if (res.http_code < 200 || res.http_code >= 300) {
    throw new Error(`Creating Bridge webhook failed (HTTP ${res.http_code}): ${res.body}\nIf the account has too many endpoints, pass --webhook-id to delete/recreate one.`)
  }
  log(`  · created webhook endpoint ${res.json?.id}`)
  return activateWebhookEndpoint(res.json, publicWebhookUrl, opts)
}

async function ensureBridgeWebhookEndpoint(publicWebhookUrl: string, opts: WebhookSetupOptions): Promise<string> {
  if (opts.webhookId) {
    log(`  · deleting webhook ${opts.webhookId} to make room for a fresh endpoint`)
    requireApiSuccess(await apiRequest('DELETE', `/webhooks/${opts.webhookId}`), `Deleting Bridge webhook ${opts.webhookId}`)
    return createWebhookEndpoint(publicWebhookUrl, opts)
  }

  const listRes = await apiRequest('GET', '/webhooks')
  requireApiSuccess(listRes, 'Listing Bridge webhooks')
  const endpoints: any[] = listRes.json?.data ?? []
  const existing = endpoints.find((e) => e.url === publicWebhookUrl)
    ?? endpoints.find((e) => (e.url ?? '').includes(opts.webhookPath) && (e.url ?? '').includes('ngrok'))

  if (existing) {
    if (opts.recreate) {
      log(`  · deleting old profiler webhook ${existing.id}`)
      requireApiSuccess(await apiRequest('DELETE', `/webhooks/${existing.id}`), `Deleting Bridge webhook ${existing.id}`)
      return createWebhookEndpoint(publicWebhookUrl, opts)
    }
    log(`  · reusing webhook endpoint ${existing.id}`)
    return activateWebhookEndpoint(existing, publicWebhookUrl, opts)
  }

  return createWebhookEndpoint(publicWebhookUrl, opts)
}

async function deleteBridgeWebhook(webhookId: string) {
  const res = await apiRequest('DELETE', `/webhooks/${webhookId}`)
  if (res.http_code >= 200 && res.http_code < 300) log(`  ✓ deleted Bridge webhook ${webhookId}`)
  else log(`  ⚠ could not delete Bridge webhook ${webhookId} (HTTP ${res.http_code})`)
}

// --- on-chain (Tempo via viem) ---

type TempoClient = ReturnType<typeof createClient>

function makeTempoClient(privateKey: string, rpcUrl: string): TempoClient {
  const account = privateKeyToAccount(privateKey as Hex)
  return createClient({ account, transport: http(rpcUrl) })
}

/** Read-only client for tx timestamp lookups on any EVM chain. */
type ReadClient = { getTransactionReceipt: (args: any) => Promise<any>; getBlock: (args: any) => Promise<any> }

function makeReadClient(rpcUrl: string): ReadClient {
  return createPublicClient({ transport: http(rpcUrl) }) as unknown as ReadClient
}

/** Default public RPC URLs per destination rail, for tx timestamp lookups. */
const DEFAULT_DEST_RPC_URLS: Record<string, string> = {
  tempo: 'https://rpc.tempo.xyz',
  polygon: 'https://polygon-bor-rpc.publicnode.com',
  ethereum: 'https://ethereum-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  arbitrum: 'https://arbitrum-one-rpc.publicnode.com',
  optimism: 'https://optimism-rpc.publicnode.com',
}

/** viem chain definitions per EVM rail, for reverse (return) transfers. */
const EVM_CHAINS: Record<string, Chain> = {
  polygon,
  ethereum: mainnet,
  base,
  arbitrum,
  optimism,
}

/** USDC contract addresses per EVM rail, for reverse (return) transfers. */
const EVM_USDC_ADDRESSES: Record<string, Address> = {
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  optimism: '0x0b2C639c533813f4Aa9D7837CAcAd6dA3ABF2Fc4A',
}

export function resolveTempoFeeTokenAddress(feeToken: string): Address {
  const lower = feeToken.toLowerCase()
  if (['pathusd', 'path_usd'].includes(lower)) return TEMPO_PATHUSD_TOKEN_ADDRESS
  if (['usdc.e', 'usdce', 'usdc_e', 'usdc'].includes(lower)) return TEMPO_USDC_E_TOKEN_ADDRESS
  if ([TEMPO_PATHUSD_TOKEN_ADDRESS, TEMPO_USDC_E_TOKEN_ADDRESS].includes(lower)) return feeToken as Address
  throw new Error('--fee-token must be pathusd, usdc.e, or a known Tempo fee token address')
}

const ERC20_ABI = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
] as const

async function tokenBalanceAtomics(client: TempoClient, token: Address, account: Address): Promise<bigint> {
  return (client as any).readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account] })
}

type TxTimestampLookup = {
  tx_hash: string
  block_number?: string
  block_timestamp_epoch?: number
  block_timestamp_iso?: string
  error?: string
}

async function lookupTxTimestamp(client: ReadClient | TempoClient, txHash: string, retries: number, sleepSeconds: number): Promise<TxTimestampLookup> {
  let lastError = 'transaction receipt not available'
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const receipt = await (client as any).getTransactionReceipt({ hash: txHash as Hex })
      if (receipt?.blockNumber != null) {
        const block = await (client as any).getBlock({ blockNumber: receipt.blockNumber })
        const epoch = Number(block.timestamp)
        return {
          tx_hash: txHash,
          block_number: receipt.blockNumber.toString(),
          block_timestamp_epoch: epoch,
          block_timestamp_iso: isoFromEpoch(epoch),
        }
      }
    } catch (err) {
      lastError = String(err instanceof Error ? err.message : err).split('\n')[0]!
    }
    await sleep(sleepSeconds * 1000)
  }
  return { tx_hash: txHash, error: lastError }
}

async function returnFundsWithClient(
  client: TempoClient,
  params: { token: Address; feeToken: Address; to: Address; atoms: bigint; amount: string; currency: string; logPath: string },
): Promise<boolean> {
  log(`  · returning ${params.amount} ${params.currency} to Bridge wallet ${shortHash(params.to)}…`)
  try {
    const result = await (client as any).token.transferSync({
      amount: params.atoms,
      to: params.to,
      token: params.token,
      feeToken: params.feeToken,
    })
    const txHash = result.receipt?.transactionHash ?? '<unknown>'
    appendFileSync(params.logPath, JSON.stringify({ ok: true, tx_hash: txHash, amount: params.amount, to: params.to, at: isoFromEpoch(nowEpoch()) }) + '\n')
    log(`  ✓ funds returned (tx ${shortHash(txHash)})`)
    return true
  } catch (err) {
    appendFileSync(params.logPath, JSON.stringify({ ok: false, error: String(err), amount: params.amount, to: params.to, at: isoFromEpoch(nowEpoch()) }) + '\n')
    log(`  ✗ return transfer failed: ${String(err instanceof Error ? err.message : err).split('\n')[0]}`)
    return false
  }
}

/**
 * Return funds from an EVM chain back to the local wallet on Tempo by creating a reverse
 * Bridge transfer (<rail> → tempo) and funding its deposit address with an ERC-20 transfer.
 * Requires native gas (e.g. POL on Polygon) on the source chain.
 */
async function returnViaBridgeTransfer(params: {
  privateKey: string
  fromRail: string
  fromCurrency: string
  toCurrency: string
  toAddress: Address
  amount: string
  tokenDecimals: number
  rpcUrl?: string | undefined
  onBehalfOf: string
  timeoutSeconds: number
  logPath: string
}): Promise<boolean> {
  const chain = EVM_CHAINS[params.fromRail]
  const token = params.fromCurrency.toLowerCase() === 'usdc' ? EVM_USDC_ADDRESSES[params.fromRail] : undefined
  if (!chain || !token) {
    log(`  ✗ return not supported: no ${params.fromCurrency} token/chain config for rail ${params.fromRail}`)
    return false
  }
  const rpcUrl = params.rpcUrl ?? DEFAULT_DEST_RPC_URLS[params.fromRail]!
  const account = privateKeyToAccount(params.privateKey as Hex)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })

  const record = (entry: Record<string, unknown>) =>
    appendFileSync(params.logPath, JSON.stringify({ ...entry, at: isoFromEpoch(nowEpoch()) }) + '\n')

  log(`  · returning ${params.amount} ${params.fromCurrency} from ${params.fromRail} to Tempo ${shortHash(params.toAddress)} via reverse Bridge transfer…`)
  try {
    const [gasBalance, tokenBalance] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] }) as Promise<bigint>,
    ])
    if (gasBalance === 0n) {
      log(`  ✗ return failed: ${account.address} has no ${chain.nativeCurrency.symbol} on ${params.fromRail} to pay gas`)
      log(`    fund it, then run: bridgerton profile return-funds --from-rail ${params.fromRail}`)
      record({ ok: false, error: 'no_native_gas', chain: params.fromRail })
      return false
    }
    const atoms = amountToAtomics(params.amount, params.tokenDecimals)
    if (tokenBalance < atoms) {
      const balance = atomicsToAmount(tokenBalance, params.tokenDecimals)
      log(`  ✗ return failed: ${params.fromRail} ${params.fromCurrency} balance ${balance} is less than return amount ${params.amount}`)
      record({ ok: false, error: 'insufficient_token_balance', balance })
      return false
    }

    const createRes = await apiRequest('POST', '/transfers', {
      amount: params.amount,
      on_behalf_of: params.onBehalfOf,
      source: { payment_rail: params.fromRail, currency: params.fromCurrency },
      destination: { payment_rail: 'tempo', currency: params.toCurrency, to_address: params.toAddress },
      features: { allow_any_from_address: true },
    }, crypto.randomUUID())
    requireApiSuccess(createRes, 'Creating return transfer')
    const transfer = createRes.json
    const depositTo = transfer?.source_deposit_instructions?.to_address
    if (!depositTo) {
      log(`  ✗ return failed: return transfer response missing source_deposit_instructions.to_address`)
      record({ ok: false, error: 'missing_deposit_instructions', transfer_id: transfer?.id })
      return false
    }
    const depositAmount: string = transfer.source_deposit_instructions.amount ?? params.amount

    const txHash = await walletClient.writeContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [depositTo as Address, amountToAtomics(depositAmount, params.tokenDecimals)],
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })
    log(`  · deposit sent on ${params.fromRail} (tx ${shortHash(txHash)}) — waiting for Bridge to process…`)

    const deadline = Date.now() + params.timeoutSeconds * 1000
    let lastState = ''
    while (Date.now() < deadline) {
      await sleep(10_000)
      const state = normalizeStatus((await apiRequest('GET', `/transfers/${transfer.id}`)).json?.state ?? '')
      if (state && state !== lastState) {
        lastState = state
        log(`  · return transfer ${state}`)
      }
      if (state === 'payment_processed') {
        record({ ok: true, transfer_id: transfer.id, tx_hash: txHash, amount: params.amount, from_rail: params.fromRail })
        log(`  ✓ funds returned to Tempo (transfer ${shortId(transfer.id)})`)
        return true
      }
      if (['returned', 'refunded', 'canceled', 'error'].includes(state)) {
        record({ ok: false, error: `return_transfer_${state}`, transfer_id: transfer.id, tx_hash: txHash })
        log(`  ✗ return transfer ended in state ${state}`)
        return false
      }
    }
    record({ ok: false, error: 'timed_out_waiting_for_payment_processed', transfer_id: transfer.id, tx_hash: txHash })
    log(`  ⚠ return transfer ${shortId(transfer.id)} not processed within ${params.timeoutSeconds}s — deposit tx ${shortHash(txHash)} was sent; check the transfer later`)
    return false
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).split('\n')[0]!
    record({ ok: false, error: msg })
    log(`  ✗ return failed: ${msg}`)
    return false
  }
}

// --- Bridge wallet address ---

async function fetchBridgeWalletAddress(walletId: string): Promise<string> {
  const res = await apiRequest('GET', `/wallets/${walletId}`)
  requireApiSuccess(res, `Fetching Bridge wallet ${walletId}`)
  const address = res.json?.address ?? res.json?.data?.address ?? res.json?.wallet?.address
  if (!address) throw new Error(`Bridge wallet ${walletId} response did not include an address`)
  return address
}

// --- result rows, CSV, summary ---

const CSV_HEADER = 'run_index,direction,client_reference_id,idempotency_key,transfer_id,api_http_status,completed,timed_out,error,request_start_iso,api_response_iso,deposit_tx_hash,deposit_tx_iso,payment_submitted_iso,tx_timestamp_iso,payment_processed_iso,payment_submitted_tx_hashes,payment_processed_tx_hashes,tx_hash_for_timestamp,request_start_to_api_response_ms,request_start_to_deposit_tx_ms,request_start_to_payment_submitted_ms,request_start_to_tx_timestamp_ms,request_start_to_payment_processed_ms,deposit_tx_to_payment_submitted_ms,deposit_tx_to_tx_timestamp_ms,deposit_tx_to_payment_processed_ms,payment_submitted_to_tx_timestamp_ms,tx_timestamp_to_payment_submitted_ms,tx_timestamp_to_payment_processed_ms,api_response_to_payment_submitted_ms,api_response_to_payment_processed_ms,payment_submitted_to_payment_processed_ms,return_attempted,return_tx_log\n'

function csvValue(v: unknown): string {
  if (v == null) return '""'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return '"' + String(v).replace(/"/g, '""') + '"'
}

function appendCsvRow(csvPath: string, row: any) {
  const l = row.latencies_ms
  const cells = [
    row.run_index, row.direction ?? 'forward', row.client_reference_id, row.idempotency_key, row.transfer_id, row.api_http_status,
    row.completed, row.timed_out, row.error ?? '', row.request_start_iso, row.api_response_iso,
    row.deposit?.tx_hash ?? '', row.deposit?.block_timestamp_iso ?? '',
    row.payment_submitted?.received_iso ?? '', row.tx_timestamp?.block_timestamp_iso ?? '',
    row.payment_processed?.received_iso ?? '',
    (row.payment_submitted?.summary?.tx_hashes ?? []).join(';'),
    (row.payment_processed?.summary?.tx_hashes ?? []).join(';'),
    row.tx_timestamp?.tx_hash ?? '',
    l.request_start_to_api_response_ms ?? '', l.request_start_to_deposit_tx_ms ?? '',
    l.request_start_to_payment_submitted_ms ?? '',
    l.request_start_to_tx_timestamp_ms ?? '', l.request_start_to_payment_processed_ms ?? '',
    l.deposit_tx_to_payment_submitted_ms ?? '', l.deposit_tx_to_tx_timestamp_ms ?? '',
    l.deposit_tx_to_payment_processed_ms ?? '',
    l.payment_submitted_to_tx_timestamp_ms ?? '', l.tx_timestamp_to_payment_submitted_ms ?? '',
    l.tx_timestamp_to_payment_processed_ms ?? '', l.api_response_to_payment_submitted_ms ?? '',
    l.api_response_to_payment_processed_ms ?? '', l.payment_submitted_to_payment_processed_ms ?? '',
    row.return_attempted, row.return_tx_log ?? '',
  ]
  appendFileSync(csvPath, cells.map(csvValue).join(',') + '\n')
}

// The one metric we report on: full lifecycle latency, transfer creation → payment_processed.
// All intermediate timings are still recorded per-row in the results JSONL/CSV.
const LIFECYCLE_METRIC = 'request_start_to_payment_processed_ms'

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null
  return sorted[Math.ceil((sorted.length * p) / 100) - 1] ?? null
}

function summarizeRows(rows: any[]) {
  const values = rows
    .map((row) => row.latencies_ms?.[LIFECYCLE_METRIC] as number | null | undefined)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b)
  return {
    transfers: rows.length,
    completed: rows.filter((r) => r.completed === true).length,
    timed_out: rows.filter((r) => r.timed_out === true).length,
    errors: rows.filter((r) => (r.error ?? '') !== '').length,
    latency_ms: {
      n: values.length,
      avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null,
      p50: percentile(values, 50),
      p90: percentile(values, 90),
      p95: percentile(values, 95),
      min: values.length ? values[0]! : null,
      max: values.length ? values[values.length - 1]! : null,
    },
  }
}

/** Print one lifecycle-latency table with a row per direction. */
function printSummaryTable(sections: { label: string; summary: ReturnType<typeof summarizeRows> }[]) {
  const fmtSeconds = (ms: number | null) => (ms == null ? '—' : (ms / 1000).toFixed(2))
  log('')
  log('Summary — request start → payment_processed (seconds)')
  log('─'.repeat(64))
  const labelWidth = Math.max(...sections.map((s) => s.label.length), 'route'.length)
  const col = 8
  const headerCells = ['runs', 'avg', 'p50', 'p90', 'p95', 'min', 'max']
  log(`  ${'route'.padEnd(labelWidth)}  ${headerCells.map((h) => h.padStart(col)).join('')}`)
  log(`  ${'─'.repeat(labelWidth)}  ${headerCells.map(() => ' ' + '─'.repeat(col - 1)).join('')}`)
  for (const { label, summary } of sections) {
    const l = summary.latency_ms
    const runs = `${summary.completed}/${summary.transfers}`
    const cells = [runs, fmtSeconds(l.avg), fmtSeconds(l.p50), fmtSeconds(l.p90), fmtSeconds(l.p95), fmtSeconds(l.min), fmtSeconds(l.max)]
    log(`  ${label.padEnd(labelWidth)}  ${cells.map((c) => c.padStart(col)).join('')}`)
  }
  const problems = sections
    .filter(({ summary }) => summary.timed_out || summary.errors)
    .map(({ label, summary }) => `${label}: ${[summary.timed_out ? `${summary.timed_out} timed out` : '', summary.errors ? `${summary.errors} error${summary.errors === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}`)
  if (problems.length) log(`  ⚠ ${problems.join(' · ')}`)
}

/** Best-effort route label ("tempo → polygon") from a result row's request payload. */
function routeLabel(rows: any[], fallback: string): string {
  const payload = rows[0]?.request_payload
  const from = payload?.source?.payment_rail
  const to = payload?.destination?.payment_rail
  return from && to ? `${from} → ${to}` : fallback
}

function readResultsJsonl(path: string): any[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** Summarize a previous run's results JSONL file (split by trip direction when present). */
export function summarizeResults(resultsFile: string) {
  const rows = readResultsJsonl(resultsFile)
  const forwardRows = rows.filter((r) => (r.direction ?? 'forward') === 'forward')
  const returnRows = rows.filter((r) => r.direction === 'return')
  const summary = summarizeRows(forwardRows)
  const sections = [{ label: routeLabel(forwardRows, 'forward'), summary }]
  if (returnRows.length) {
    const returnSummary = summarizeRows(returnRows)
    sections.push({ label: routeLabel(returnRows, 'return'), summary: returnSummary })
    printSummaryTable(sections)
    return { summary, return_summary: returnSummary }
  }
  printSummaryTable(sections)
  return summary
}

// --- profile run ---

export type ProfileRunOptions = {
  onBehalfOf?: string | undefined
  sourceRail: string
  sourceCurrency: string
  sourceWalletId?: string | undefined
  destRail: string
  destCurrency: string
  destAddress?: string | undefined
  amount: string
  runs: number
  batchSize: number
  timeoutSeconds: number
  returnFundsAtEnd: boolean
  batchReturnSingleTx: boolean
  stopOnInsufficientBalance: boolean
  postReturnSettleSeconds: number
  feeToken: string
  tokenContract: string
  tokenDecimals: number
  rpcUrl: string
  destRpcUrl?: string | undefined
  webhookPort: number
  webhookPath: string
  publicWebhookUrl?: string | undefined
  ngrokDomain?: string | undefined
  webhookId?: string | undefined
  recreateWebhook: boolean
  deleteWebhookOnExit: boolean
  eventCategories: string
  eventEpoch: string
  selfTest: boolean
  debugOnTimeout: boolean
  txTimestampLookup: boolean
  txTimestampRpcRetries: number
  txTimestampRpcSleepSeconds: number
  outputDir: string
  outputPrefix?: string | undefined
  clientReferencePrefix: string
  verbose: boolean
}

function resolveWalletPrivateKey(): string {
  const key = process.env.PROFILE_WALLET_PRIVATE_KEY ?? process.env.CAST_WALLET_PRIVATE_KEY
  if (!key) throw new Error('Set PROFILE_WALLET_PRIVATE_KEY (or CAST_WALLET_PRIVATE_KEY) in the environment')
  return key
}

function isInsufficientBalanceResponse(res: ApiResponse): boolean {
  if (res.http_code !== 400) return false
  return (res.body ?? '').toLowerCase().includes('higher than the balance')
}

type DepositRecord = {
  to_address: string
  amount: string
  tx_hash?: string
  sent_epoch?: number
  block_number?: string
  block_timestamp_epoch?: number
  block_timestamp_iso?: string
  error?: string
}

type TransferRequestRecord = {
  run_index: number
  client_reference_id: string
  idempotency_key: string
  transfer_id: string
  request_start_epoch: number
  api_response_epoch: number
  api_http_status: number
  request_payload: any
  api_response: ApiResponse
  deposit?: DepositRecord | null
}

export async function runProfile(options: ProfileRunOptions) {
  const onBehalfOf = options.onBehalfOf ?? process.env.CUSTOMER_ID
  const sourceWalletId = options.sourceWalletId ?? process.env.BRIDGE_WALLET_ID
  if (!onBehalfOf) throw new Error('Pass --on-behalf-of (or set CUSTOMER_ID in the environment)')
  const cryptoSource = options.sourceRail !== 'bridge_wallet'
  if (cryptoSource && options.sourceRail !== 'tempo') throw new Error('Only bridge_wallet and tempo source rails are supported so far')
  if (!cryptoSource && !sourceWalletId) throw new Error('Pass --source-wallet-id (or set BRIDGE_WALLET_ID in the environment)')

  const privateKey = resolveWalletPrivateKey()
  const account = privateKeyToAccount(privateKey as Hex)
  const destAddress = options.destAddress ?? account.address
  const tempoDest = options.destRail === 'tempo'
  const returnsEnabled = !cryptoSource && tempoDest
  // For EVM destinations we run measured return trips (reverse Bridge transfers) at end of
  // run, but only when the destination is the local wallet (we control the funds).
  const evmReturnsEnabled = cryptoSource && !tempoDest && EVM_CHAINS[options.destRail] != null
    && EVM_USDC_ADDRESSES[options.destRail] != null && options.destCurrency.toLowerCase() === 'usdc'
    && (options.destAddress ?? account.address).toLowerCase() === account.address.toLowerCase()

  const tempoClient = makeTempoClient(privateKey, options.rpcUrl)
  const feeTokenAddress = resolveTempoFeeTokenAddress(options.feeToken)
  const tokenContract = options.tokenContract as Address
  const bridgeWalletAddress = cryptoSource ? null : await fetchBridgeWalletAddress(sourceWalletId!)

  const destRpcUrl = options.destRpcUrl ?? (tempoDest ? options.rpcUrl : DEFAULT_DEST_RPC_URLS[options.destRail])
  const destReadClient = options.txTimestampLookup && destRpcUrl ? makeReadClient(destRpcUrl) : null

  // EVM clients for return-trip deposits (funds live on the forward destination chain).
  const evmChain = evmReturnsEnabled ? EVM_CHAINS[options.destRail]! : null
  const evmToken = evmReturnsEnabled ? EVM_USDC_ADDRESSES[options.destRail]! : null
  const evmPublicClient = evmChain && destRpcUrl ? createPublicClient({ chain: evmChain, transport: http(destRpcUrl) }) : null
  const evmWalletClient = evmChain && destRpcUrl ? createWalletClient({ account, chain: evmChain, transport: http(destRpcUrl) }) : null

  /** Direction-specific parameters shared by the transfer create/fund/finalize steps. */
  type TripSpec = {
    direction: 'forward' | 'return'
    label: string
    sourceRail: string
    sourceCurrency: string
    destRail: string
    destCurrency: string
    destAddress: string
    /** true when we fund the transfer ourselves via its deposit instructions */
    depositFunded: boolean
    /** client used to resolve destination tx timestamps for this trip */
    timestampClient: ReadClient | TempoClient | null
  }

  const forwardTrip: TripSpec = {
    direction: 'forward',
    label: 'run',
    sourceRail: options.sourceRail,
    sourceCurrency: options.sourceCurrency,
    destRail: options.destRail,
    destCurrency: options.destCurrency,
    destAddress,
    depositFunded: cryptoSource,
    timestampClient: destReadClient,
  }

  const returnTrip: TripSpec = {
    direction: 'return',
    label: 'return',
    sourceRail: options.destRail,
    sourceCurrency: options.destCurrency,
    destRail: 'tempo',
    destCurrency: options.sourceCurrency,
    destAddress: account.address,
    depositFunded: true,
    timestampClient: options.txTimestampLookup ? tempoClient : null,
  }

  mkdirSync(options.outputDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')
  const prefix = options.outputPrefix ?? `transfer_webhook_latency_${options.sourceRail}_${options.destRail}_${ts}`
  const resultsJsonl = join(options.outputDir, `${prefix}.results.jsonl`)
  const resultsCsv = join(options.outputDir, `${prefix}.results.csv`)
  const webhooksJsonl = join(options.outputDir, `${prefix}.webhooks.jsonl`)
  const returnsLog = join(options.outputDir, `${prefix}.returns.log`)
  writeFileSync(resultsJsonl, '')
  writeFileSync(webhooksJsonl, '')
  writeFileSync(returnsLog, '')
  writeFileSync(resultsCsv, CSV_HEADER)

  const receiver = new WebhookReceiver(webhooksJsonl, options.verbose)
  await receiver.listen(options.webhookPort)

  let tunnel: { url: string; close: () => Promise<void> } | undefined
  let configuredWebhookId: string | undefined
  let cleanedUp = false
  const cleanup = async () => {
    if (cleanedUp) return
    cleanedUp = true
    if (configuredWebhookId && options.deleteWebhookOnExit) await deleteBridgeWebhook(configuredWebhookId)
    await tunnel?.close().catch(() => {})
    await receiver.close()
  }
  const onInterrupt = () => {
    log('\n⚠ interrupted — stopping profiler cleanly')
    void cleanup().then(() => process.exit(130))
  }
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', onInterrupt)

  try {
    log('')
    log('Transfer webhook latency profiler')
    log('─'.repeat(64))
    log(`  route         ${options.sourceRail} (${options.sourceCurrency}) → ${options.destRail} (${options.destCurrency})`)
    if (cryptoSource) log(`  source        local wallet ${account.address} (deposit-funded)`)
    else log(`  source        wallet ${sourceWalletId} (${bridgeWalletAddress})`)
    log(`  destination   ${destAddress}`)
    log(`  amount        ${options.amount} ${options.sourceCurrency} × ${options.runs} run${options.runs === 1 ? '' : 's'} (batch size ${options.batchSize})`)
    log(`  fee token     ${options.feeToken} (${feeTokenAddress})`)
    if (destReadClient) log(`  dest RPC      ${destRpcUrl}`)
    log(`  receiver      http://127.0.0.1:${options.webhookPort}${options.webhookPath}`)
    if (!destReadClient) log(`  ⚠ no RPC known for destination rail ${options.destRail} — dest tx timestamp lookup disabled (pass --dest-rpc-url)`)
    if (evmReturnsEnabled) log(`  · measured return trips (${options.destRail} → tempo) run at end, one per completed run (needs ${evmChain!.nativeCurrency.symbol} gas on ${options.destRail})`)
    else if (!returnsEnabled) log(`  ⚠ fund returns disabled for this route`)
    log('')
    log('Setup')

    let publicWebhookUrl = options.publicWebhookUrl
    if (publicWebhookUrl) {
      log(`  · using provided public webhook URL ${publicWebhookUrl}`)
    } else {
      tunnel = await startTunnel(options.webhookPort, options.ngrokDomain)
      publicWebhookUrl = `${tunnel.url}${options.webhookPath}`
      log(`  ✓ ngrok tunnel ready: ${publicWebhookUrl}`)
    }

    if (options.selfTest) {
      const selfRef = `__bridgerton_profiler_selftest_${Date.now()}`
      log('  · verifying public URL reaches the local webhook receiver…')
      const res = await fetch(publicWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_id: selfRef,
          event_object_id: selfRef,
          event_object_status: 'selfTest',
          event_object: { id: selfRef, client_reference_id: selfRef, tx_hash: '0xselftest' },
        }),
      })
      if (!res.ok) throw new Error(`Webhook self-test POST to ${publicWebhookUrl} returned HTTP ${res.status}`)
      const record = await receiver.waitForEvent([selfRef], 'selftest', 10)
      if (!record) throw new Error(`Webhook self-test POST returned ${res.status}, but the local receiver did not record it`)
      log('  ✓ webhook self-test passed')
    }

    configuredWebhookId = await ensureBridgeWebhookEndpoint(publicWebhookUrl, {
      webhookId: options.webhookId,
      recreate: options.recreateWebhook,
      eventCategories: options.eventCategories,
      eventEpoch: options.eventEpoch,
      webhookPath: options.webhookPath,
    })

    const createTransferRequest = async (runIndex: number, trip: TripSpec): Promise<TransferRequestRecord> => {
      const refTag = trip.direction === 'return' ? '-ret' : ''
      const clientReferenceId = `${options.clientReferencePrefix}${refTag}-${Math.floor(Date.now() / 1000)}-${runIndex}-${Math.floor(Math.random() * 32768)}`
      const idempotencyKey = crypto.randomUUID()
      const payload = {
        amount: options.amount,
        on_behalf_of: onBehalfOf,
        client_reference_id: clientReferenceId,
        source: trip.depositFunded
          ? { payment_rail: trip.sourceRail, currency: trip.sourceCurrency }
          : { payment_rail: trip.sourceRail, currency: trip.sourceCurrency, bridge_wallet_id: sourceWalletId },
        destination: { payment_rail: trip.destRail, currency: trip.destCurrency, to_address: trip.destAddress },
        ...(trip.depositFunded ? { features: { allow_any_from_address: true } } : {}),
      }
      log(`  ${trip.label} ${runIndex}: creating transfer…`)
      const requestStart = nowEpoch()
      const apiResponse = await apiRequest('POST', '/transfers', payload, idempotencyKey)
      return {
        run_index: runIndex,
        client_reference_id: clientReferenceId,
        idempotency_key: idempotencyKey,
        transfer_id: apiResponse.json?.id ?? apiResponse.json?.transfer_id ?? apiResponse.json?.data?.id ?? '',
        request_start_epoch: requestStart,
        api_response_epoch: nowEpoch(),
        api_http_status: apiResponse.http_code,
        request_payload: payload,
        api_response: apiResponse,
      }
    }

    /** Send a deposit on Tempo (forward trips with a tempo source). */
    const sendDepositTempo = async (to: Address, atoms: bigint, memo?: string): Promise<string> => {
      const result = await (tempoClient as any).token.transferSync({
        amount: atoms,
        to,
        token: tokenContract,
        feeToken: feeTokenAddress,
        ...(memo ? { memo: stringToHex(memo) } : {}),
      })
      return result.receipt?.transactionHash ?? ''
    }

    /** Send a deposit on the EVM destination chain (return trips). */
    const sendDepositEvm = async (to: Address, atoms: bigint): Promise<string> => {
      const txHash = await evmWalletClient!.writeContract({
        address: evmToken!,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [to, atoms],
      })
      await evmPublicClient!.waitForTransactionReceipt({ hash: txHash })
      return txHash
    }

    /** Fund a crypto-source transfer by sending tokens to its Bridge deposit address. */
    const fundDeposit = async (request: TransferRequestRecord, trip: TripSpec): Promise<void> => {
      const i = request.run_index
      if (request.api_http_status < 200 || request.api_http_status >= 300) return
      const instructions = request.api_response.json?.source_deposit_instructions
      const toAddress: string | undefined = instructions?.to_address
      const depositAmount = String(instructions?.amount ?? options.amount)
      if (!toAddress) {
        request.deposit = { to_address: '', amount: depositAmount, error: 'transfer response missing source_deposit_instructions.to_address' }
        log(`  ${trip.label} ${i}: ✗ no deposit instructions in transfer response`)
        return
      }
      const memo: string | undefined = instructions?.blockchain_memo
      log(`  ${trip.label} ${i}: depositing ${depositAmount} ${trip.sourceCurrency} to ${shortHash(toAddress)}…`)
      const sentEpoch = nowEpoch()
      try {
        const atoms = amountToAtomics(depositAmount, options.tokenDecimals)
        const txHash = trip.direction === 'return'
          ? await sendDepositEvm(toAddress as Address, atoms)
          : await sendDepositTempo(toAddress as Address, atoms, memo)
        const deposit: DepositRecord = { to_address: toAddress, amount: depositAmount, tx_hash: txHash, sent_epoch: sentEpoch }
        if (txHash) {
          const depositChainClient = trip.direction === 'return' ? evmPublicClient! : tempoClient
          const ts = await lookupTxTimestamp(depositChainClient, txHash, options.txTimestampRpcRetries, options.txTimestampRpcSleepSeconds)
          if (ts.block_number != null) deposit.block_number = ts.block_number
          if (ts.block_timestamp_epoch != null) deposit.block_timestamp_epoch = ts.block_timestamp_epoch
          if (ts.block_timestamp_iso != null) deposit.block_timestamp_iso = ts.block_timestamp_iso
        }
        request.deposit = deposit
        log(`  ${trip.label} ${i}: ✓ deposit sent (tx ${shortHash(txHash || '<unknown>')})`)
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err).split('\n')[0]!
        request.deposit = { to_address: toAddress, amount: depositAmount, sent_epoch: sentEpoch, error: msg }
        log(`  ${trip.label} ${i}: ✗ deposit failed: ${msg}`)
      }
    }

    // Bridge webhook delivery for payment_processed is occasionally missed (observed on
    // cross-chain routes), so we race the webhook wait against polling the transfer API.
    const PROCESSED_POLL_INTERVAL_SECONDS = 10
    const waitForProcessed = (keys: (string | undefined)[], transferId: string | undefined): Promise<WebhookRecord | null> => {
      const webhookWait = receiver.waitForEvent(keys, 'payment_processed', options.timeoutSeconds)
      if (!transferId) return webhookWait

      let settled = false
      return new Promise<WebhookRecord | null>((resolve) => {
        const settle = (record: WebhookRecord | null) => {
          if (settled) return
          settled = true
          resolve(record)
        }
        void webhookWait.then(settle) // resolves with the record, or null at timeout

        void (async () => {
          const deadline = Date.now() + options.timeoutSeconds * 1000
          while (!settled && Date.now() < deadline) {
            await sleep(Math.min(PROCESSED_POLL_INTERVAL_SECONDS * 1000, Math.max(0, deadline - Date.now())))
            if (settled) return
            const transfer = (await apiRequest('GET', `/transfers/${transferId}`)).json
            if (normalizeStatus(transfer?.state ?? transfer?.status ?? '') !== 'payment_processed') continue
            // Prefer Bridge's updated_at (state-change time) over our poll time, which
            // lags the actual transition by up to one poll interval.
            const updatedEpoch = transfer.updated_at ? Date.parse(transfer.updated_at) / 1000 : NaN
            const epoch = Number.isFinite(updatedEpoch) ? updatedEpoch : nowEpoch()
            const destinationTxHash = transfer.receipt?.destination_tx_hash
            settle({
              received_epoch: epoch,
              received_iso: isoFromEpoch(epoch),
              source: 'api_poll',
              summary: {
                event_id: '',
                event_object_id: transfer.id ?? transferId,
                client_reference_id: transfer.client_reference_id ?? '',
                status: transfer.state ?? '',
                normalized_status: 'payment_processed',
                tx_hashes: extractTxHashes(transfer),
                ...(typeof destinationTxHash === 'string' && destinationTxHash ? { destination_tx_hash: destinationTxHash } : {}),
              },
              payload: transfer,
            })
            return
          }
        })()
      })
    }

    const finalizeTransferResult = async (request: TransferRequestRecord, trip: TripSpec) => {
      const i = request.run_index
      let completed = false
      let timedOut = false
      let error: string | null = null
      let submitted: WebhookRecord | null = null
      let processed: WebhookRecord | null = null
      let txTimestamp: TxTimestampLookup | null = null
      let timeoutDebug: any = null
      let returnAttempted = false

      if (request.api_http_status < 200 || request.api_http_status >= 300) {
        error = `bridge_api_returned_http_${request.api_http_status}`
        log(`  ${trip.label} ${i}: ✗ Bridge API returned HTTP ${request.api_http_status}`)
        log(request.api_response.body)
      } else if (trip.depositFunded && (!request.deposit || request.deposit.error)) {
        error = `deposit_failed: ${request.deposit?.error ?? 'deposit was not sent'}`
      } else {
        log(`  ${trip.label} ${i}: transfer ${shortId(request.transfer_id || '<missing>')} — waiting for payment_processed…`)
        const keys = [request.client_reference_id, request.transfer_id]
        processed = await waitForProcessed(keys, request.transfer_id ?? undefined)
        if (processed) {
          completed = true
          returnAttempted = trip.direction === 'forward'
        } else {
          timedOut = true
          error = 'timed_out_waiting_for_payment_processed'
          if (options.debugOnTimeout) {
            const transferLookup = request.transfer_id ? await apiRequest('GET', `/transfers/${request.transfer_id}`) : null
            timeoutDebug = {
              client_reference_id: request.client_reference_id,
              transfer_id: request.transfer_id,
              transfer_lookup: transferLookup,
              webhook_records: receiver.recordCount,
              recent_webhooks: receiver.recentSummaries(8),
            }
            const state = transferLookup?.json?.state ?? transferLookup?.json?.status ?? '<unknown>'
            log(`  ${trip.label} ${i}: debug — transfer state ${state}, ${receiver.recordCount} webhook records received`)
          }
        }
        submitted = receiver.readEvent(keys, 'payment_submitted')
      }

      const txHashForTimestamp = processed?.summary.destination_tx_hash ?? submitted?.summary.destination_tx_hash
        ?? processed?.summary.tx_hashes[0] ?? submitted?.summary.tx_hashes[0] ?? ''
      if (trip.timestampClient && txHashForTimestamp) {
        txTimestamp = await lookupTxTimestamp(trip.timestampClient, txHashForTimestamp, options.txTimestampRpcRetries, options.txTimestampRpcSleepSeconds)
        if (txTimestamp.block_timestamp_epoch == null) {
          log(`  ${trip.label} ${i}: ⚠ could not resolve tx timestamp for ${shortHash(txHashForTimestamp)} (${txTimestamp.error ?? 'unknown error'})`)
        }
      }

      const submittedEpoch = submitted?.received_epoch ?? null
      const processedEpoch = processed?.received_epoch ?? null
      const txEpoch = txTimestamp?.block_timestamp_epoch ?? null
      const depositEpoch = request.deposit?.block_timestamp_epoch ?? null
      const latencies = {
        request_start_to_api_response_ms: msDelta(request.request_start_epoch, request.api_response_epoch),
        request_start_to_deposit_tx_ms: msDelta(request.request_start_epoch, depositEpoch),
        request_start_to_payment_submitted_ms: msDelta(request.request_start_epoch, submittedEpoch),
        request_start_to_tx_timestamp_ms: msDelta(request.request_start_epoch, txEpoch),
        request_start_to_payment_processed_ms: msDelta(request.request_start_epoch, processedEpoch),
        deposit_tx_to_payment_submitted_ms: msDelta(depositEpoch, submittedEpoch),
        deposit_tx_to_tx_timestamp_ms: msDelta(depositEpoch, txEpoch),
        deposit_tx_to_payment_processed_ms: msDelta(depositEpoch, processedEpoch),
        payment_submitted_to_tx_timestamp_ms: msDelta(submittedEpoch, txEpoch),
        tx_timestamp_to_payment_submitted_ms: msDelta(txEpoch, submittedEpoch),
        tx_timestamp_to_payment_processed_ms: msDelta(txEpoch, processedEpoch),
        api_response_to_payment_submitted_ms: msDelta(request.api_response_epoch, submittedEpoch),
        api_response_to_payment_processed_ms: msDelta(request.api_response_epoch, processedEpoch),
        payment_submitted_to_payment_processed_ms: msDelta(submittedEpoch, processedEpoch),
      }

      const row = {
        run_index: i,
        direction: trip.direction,
        client_reference_id: request.client_reference_id,
        idempotency_key: request.idempotency_key,
        transfer_id: request.transfer_id,
        api_http_status: request.api_http_status,
        completed,
        timed_out: timedOut,
        error,
        request_start_epoch: request.request_start_epoch,
        request_start_iso: isoFromEpoch(request.request_start_epoch),
        api_response_epoch: request.api_response_epoch,
        api_response_iso: isoFromEpoch(request.api_response_epoch),
        request_payload: request.request_payload,
        api_response: request.api_response,
        deposit: request.deposit ?? null,
        payment_submitted: submitted,
        payment_processed: processed,
        tx_timestamp: txTimestamp,
        latencies_ms: latencies,
        timeout_debug: timeoutDebug,
        return_attempted: returnAttempted,
        return_tx_log: returnsLog,
      }

      if (completed) {
        const parts = [`request→processed ${fmtSecs(latencies.request_start_to_payment_processed_ms)}`]
        if (txHashForTimestamp) parts.push(`tx ${shortHash(txHashForTimestamp)}`)
        if (processed?.source === 'api_poll') parts.push('via API poll (webhook not received)')
        log(`  ${trip.label} ${i}: ✓ completed — ${parts.join(', ')}`)
      } else if (timedOut) {
        log(`  ${trip.label} ${i}: ✗ timed out after ${options.timeoutSeconds}s waiting for payment_processed`)
      } else {
        log(`  ${trip.label} ${i}: ✗ failed${error ? ` — ${error}` : ''}`)
      }
      return row
    }

    const rows: any[] = []
    let totalCompleted = 0
    let pendingReturnCount = 0
    let returnFailureCount = 0
    let stopRequested = false

    for (let batchStart = 1; batchStart <= options.runs && !stopRequested; batchStart += options.batchSize) {
      const batchEnd = Math.min(batchStart + options.batchSize - 1, options.runs)
      log('')
      log(batchStart === batchEnd ? `Run ${batchStart} of ${options.runs}` : `Runs ${batchStart}–${batchEnd} of ${options.runs}`)

      const indices = Array.from({ length: batchEnd - batchStart + 1 }, (_, k) => batchStart + k)
      const requests = await Promise.all(indices.map((i) => createTransferRequest(i, forwardTrip)))
      // Deposits are sent sequentially to avoid nonce conflicts on the local wallet.
      if (cryptoSource) for (const request of requests) await fundDeposit(request, forwardTrip)
      const batchRows = await Promise.all(requests.map((r) => finalizeTransferResult(r, forwardTrip)))

      let batchCompleted = 0
      let insufficientBalanceCount = 0
      for (const row of batchRows) {
        rows.push(row)
        appendFileSync(resultsJsonl, JSON.stringify(row) + '\n')
        appendCsvRow(resultsCsv, row)
        if (row.completed) batchCompleted += 1
        if (isInsufficientBalanceResponse(row.api_response)) insufficientBalanceCount += 1
        if (row.deposit?.error && /insufficient/i.test(row.deposit.error)) insufficientBalanceCount += 1
      }

      log(`  batch done: ${batchCompleted}/${batchEnd - batchStart + 1} completed`)
      totalCompleted += batchCompleted
      pendingReturnCount += batchCompleted

      if (insufficientBalanceCount > 0 && options.stopOnInsufficientBalance) {
        stopRequested = true
        log(`  ⚠ stopping early: source balance insufficient (${insufficientBalanceCount} failed request${insufficientBalanceCount === 1 ? '' : 's'})`)
      }

      if (!options.returnFundsAtEnd && pendingReturnCount > 0 && returnsEnabled) {
        if (options.batchReturnSingleTx) {
          const returnAmount = multiplyAmount(options.amount, pendingReturnCount, options.tokenDecimals)
          const ok = await returnFundsWithClient(tempoClient, {
            token: tokenContract, feeToken: feeTokenAddress, to: bridgeWalletAddress as Address,
            atoms: amountToAtomics(returnAmount, options.tokenDecimals), amount: returnAmount,
            currency: options.sourceCurrency, logPath: returnsLog,
          })
          if (ok) pendingReturnCount = 0
          else { returnFailureCount += 1; log(`  ⚠ return failed — ${pendingReturnCount} transfer${pendingReturnCount === 1 ? '' : 's'} carried forward`) }
        } else {
          while (pendingReturnCount > 0) {
            const ok = await returnFundsWithClient(tempoClient, {
              token: tokenContract, feeToken: feeTokenAddress, to: bridgeWalletAddress as Address,
              atoms: amountToAtomics(options.amount, options.tokenDecimals), amount: options.amount,
              currency: options.sourceCurrency, logPath: returnsLog,
            })
            if (ok) pendingReturnCount -= 1
            else { returnFailureCount += 1; log(`  ⚠ return failed — ${pendingReturnCount} transfer${pendingReturnCount === 1 ? '' : 's'} carried forward`); break }
          }
        }
      }

      if (!stopRequested && !options.returnFundsAtEnd && options.postReturnSettleSeconds > 0 && batchEnd < options.runs) {
        log(`  · waiting ${options.postReturnSettleSeconds}s for returns to settle before next batch…`)
        await sleep(options.postReturnSettleSeconds * 1000)
      }
    }

    if (options.returnFundsAtEnd && totalCompleted > 0 && returnsEnabled) {
      const returnAmount = multiplyAmount(options.amount, totalCompleted, options.tokenDecimals)
      log('')
      log('Return funds')
      const ok = await returnFundsWithClient(tempoClient, {
        token: tokenContract, feeToken: feeTokenAddress, to: bridgeWalletAddress as Address,
        atoms: amountToAtomics(returnAmount, options.tokenDecimals), amount: returnAmount,
        currency: options.sourceCurrency, logPath: returnsLog,
      })
      if (ok) pendingReturnCount = 0
      else { returnFailureCount += 1; pendingReturnCount = totalCompleted }
    }

    // EVM destinations: measured return trips (reverse Bridge transfers) at end of run,
    // one per completed forward run so both directions get symmetric latency data.
    // Deposits are sequential (nonce safety); waits run in parallel per batch.
    if (evmReturnsEnabled && pendingReturnCount > 0) {
      log('')
      log(`Return trips (${options.destRail} → tempo)`)
      const gasBalance = await evmPublicClient!.getBalance({ address: account.address })
      if (gasBalance === 0n) {
        log(`  ✗ cannot run return trips: ${account.address} has no ${evmChain!.nativeCurrency.symbol} on ${options.destRail} to pay gas`)
        log(`    fund it, then run: bridgerton profile return-funds --from-rail ${options.destRail}`)
        returnFailureCount += 1
      } else {
        const totalReturns = pendingReturnCount
        for (let batchStart = 1; batchStart <= totalReturns; batchStart += options.batchSize) {
          const batchEnd = Math.min(batchStart + options.batchSize - 1, totalReturns)
          const indices = Array.from({ length: batchEnd - batchStart + 1 }, (_, k) => batchStart + k)
          const requests = await Promise.all(indices.map((i) => createTransferRequest(i, returnTrip)))
          for (const request of requests) await fundDeposit(request, returnTrip)
          const returnRows = await Promise.all(requests.map((r) => finalizeTransferResult(r, returnTrip)))
          for (const row of returnRows) {
            rows.push(row)
            appendFileSync(resultsJsonl, JSON.stringify(row) + '\n')
            appendCsvRow(resultsCsv, row)
            if (row.completed) pendingReturnCount -= 1
            else returnFailureCount += 1
          }
        }
      }
    }

    const forwardRows = rows.filter((r) => r.direction !== 'return')
    const returnRows = rows.filter((r) => r.direction === 'return')
    const summary = summarizeRows(forwardRows)
    const returnSummary = returnRows.length ? summarizeRows(returnRows) : null
    printSummaryTable([
      { label: `${options.sourceRail} → ${options.destRail}`, summary },
      ...(returnSummary ? [{ label: `${options.destRail} → tempo (return)`, summary: returnSummary }] : []),
    ])
    log('')
    log(`  results: ${resultsJsonl}`)
    log('')

    return {
      summary,
      ...(returnSummary ? { return_summary: returnSummary } : {}),
      return_failures: returnFailureCount,
      pending_return_transfers: pendingReturnCount,
      pending_return_amount: pendingReturnCount > 0 ? multiplyAmount(options.amount, pendingReturnCount, options.tokenDecimals) : null,
      files: { results_jsonl: resultsJsonl, results_csv: resultsCsv, webhooks_jsonl: webhooksJsonl, returns_log: returnsLog },
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt)
    process.removeListener('SIGTERM', onInterrupt)
    await cleanup()
  }
}

// --- return-funds only ---

export type ReturnFundsOptions = {
  amount?: string | undefined
  sourceWalletId?: string | undefined
  bridgeWalletAddress?: string | undefined
  feeToken: string
  tokenContract: string
  tokenDecimals: number
  currency: string
  rpcUrl: string
  outputDir: string
  fromRail: string
  fromRpcUrl?: string | undefined
  onBehalfOf?: string | undefined
  timeoutSeconds: number
}

export async function runReturnFunds(options: ReturnFundsOptions) {
  const privateKey = resolveWalletPrivateKey()
  const account = privateKeyToAccount(privateKey as Hex)

  // EVM rail: reverse Bridge transfer (<rail> → tempo) back to the local wallet.
  if (options.fromRail !== 'tempo') {
    const chain = EVM_CHAINS[options.fromRail]
    const token = EVM_USDC_ADDRESSES[options.fromRail]
    if (!chain || !token) throw new Error(`--from-rail must be tempo or one of: ${Object.keys(EVM_CHAINS).join(', ')}`)
    const onBehalfOf = options.onBehalfOf ?? process.env.CUSTOMER_ID
    if (!onBehalfOf) throw new Error('Pass --on-behalf-of (or set CUSTOMER_ID in the environment)')

    let returnAmount = options.amount
    if (!returnAmount) {
      const rpcUrl = options.fromRpcUrl ?? DEFAULT_DEST_RPC_URLS[options.fromRail]!
      const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
      const balance = await publicClient.readContract({
        address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address],
      }) as bigint
      if (balance === 0n) throw new Error(`Wallet ${options.currency} balance on ${options.fromRail} is zero; nothing to return`)
      returnAmount = atomicsToAmount(balance, options.tokenDecimals)
    }

    mkdirSync(options.outputDir, { recursive: true })
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')
    const returnsLog = join(options.outputDir, `return_funds_${ts}.returns.log`)
    writeFileSync(returnsLog, '')

    log('')
    log('Return funds')
    log('─'.repeat(64))
    log(`  route      ${options.fromRail} → tempo (reverse Bridge transfer)`)
    log(`  wallet     ${account.address}`)
    log(`  amount     ${returnAmount} ${options.currency}${options.amount ? '' : ' (entire wallet balance)'}`)
    log('')

    const ok = await returnViaBridgeTransfer({
      privateKey,
      fromRail: options.fromRail,
      fromCurrency: options.currency,
      toCurrency: options.currency,
      toAddress: account.address,
      amount: returnAmount,
      tokenDecimals: options.tokenDecimals,
      rpcUrl: options.fromRpcUrl,
      onBehalfOf,
      timeoutSeconds: options.timeoutSeconds,
      logPath: returnsLog,
    })
    if (!ok) throw new Error(`Return transfer failed; see ${returnsLog}`)
    return { returned: true, amount: returnAmount, currency: options.currency, from_rail: options.fromRail, to: account.address, returns_log: returnsLog }
  }
  const tempoClient = makeTempoClient(privateKey, options.rpcUrl)
  const feeTokenAddress = resolveTempoFeeTokenAddress(options.feeToken)
  const tokenContract = options.tokenContract as Address

  const sourceWalletId = options.sourceWalletId ?? process.env.BRIDGE_WALLET_ID
  let bridgeWalletAddress = options.bridgeWalletAddress
  if (!bridgeWalletAddress) {
    if (!sourceWalletId) throw new Error('Pass --bridge-wallet-address or --source-wallet-id (or set BRIDGE_WALLET_ID)')
    bridgeWalletAddress = await fetchBridgeWalletAddress(sourceWalletId)
  }

  let returnAtoms: bigint
  let returnMode: string
  if (options.amount) {
    returnAtoms = amountToAtomics(options.amount, options.tokenDecimals)
    returnMode = 'configured_amount'
  } else {
    returnAtoms = await tokenBalanceAtomics(tempoClient, tokenContract, account.address)
    returnMode = 'entire_wallet_balance'
    if (returnAtoms === 0n) throw new Error('Wallet token balance is zero; nothing to return')
    if (tokenContract.toLowerCase() === feeTokenAddress.toLowerCase()) {
      log('⚠ returning full balance while fee token matches transfer token — pass --amount to leave a gas buffer if this fails')
    }
  }
  if (returnAtoms === 0n) throw new Error('Return amount is zero; nothing to return')
  const returnAmount = atomicsToAmount(returnAtoms, options.tokenDecimals)

  mkdirSync(options.outputDir, { recursive: true })
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, 'Z')
  const returnsLog = join(options.outputDir, `return_funds_${ts}.returns.log`)
  writeFileSync(returnsLog, '')

  log('')
  log('Return funds')
  log('─'.repeat(64))
  log(`  from       ${account.address}`)
  log(`  to         ${bridgeWalletAddress} (Bridge wallet)`)
  log(`  token      ${tokenContract}`)
  log(`  fee token  ${options.feeToken} (${feeTokenAddress})`)
  log(`  amount     ${returnAmount} ${options.currency} (${returnMode === 'entire_wallet_balance' ? 'entire wallet balance' : 'configured amount'})`)
  log('')

  const ok = await returnFundsWithClient(tempoClient, {
    token: tokenContract, feeToken: feeTokenAddress, to: bridgeWalletAddress as Address,
    atoms: returnAtoms, amount: returnAmount, currency: options.currency, logPath: returnsLog,
  })
  if (!ok) throw new Error(`Return transfer failed; see ${returnsLog}`)
  return { returned: true, amount: returnAmount, currency: options.currency, to: bridgeWalletAddress, returns_log: returnsLog }
}
