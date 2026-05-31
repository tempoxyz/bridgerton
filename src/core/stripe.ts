import { getStripeApiKey } from './client.js'

const STRIPE_API_BASE = 'https://api.stripe.com/v1'
const pathSegment = (value: string) => encodeURIComponent(value)

type StripeRequestOptions = {
  idempotencyKey?: string
}

type ListParams = {
  card?: string | undefined
  cardholder?: string | undefined
  email?: string | undefined
  endingBefore?: string | undefined
  last4?: string | undefined
  limit?: number | undefined
  startingAfter?: string | undefined
  status?: string | undefined
  type?: string | undefined
}

function appendRequestId(json: unknown, requestId: string | null) {
  if (json && typeof json === 'object' && !Array.isArray(json) && requestId) {
    return { ...json, stripe_request_id: requestId }
  }
  return json
}

function queryString(params?: ListParams) {
  if (!params) return ''
  const qs = new URLSearchParams()
  if (params.card) qs.set('card', params.card)
  if (params.cardholder) qs.set('cardholder', params.cardholder)
  if (params.email) qs.set('email', params.email)
  if (params.endingBefore) qs.set('ending_before', params.endingBefore)
  if (params.last4) qs.set('last4', params.last4)
  if (params.limit) qs.set('limit', String(params.limit))
  if (params.startingAfter) qs.set('starting_after', params.startingAfter)
  if (params.status) qs.set('status', params.status)
  if (params.type) qs.set('type', params.type)
  return qs.size ? '?' + qs.toString() : ''
}

async function stripeRequest(method: string, path: string, body?: URLSearchParams, opts?: StripeRequestOptions) {
  const apiKey = getStripeApiKey()
  if (!apiKey) throw new Error('No Stripe API key configured. Run: bridgerton configure stripe-api-key <key>')

  const headers: Record<string, string> = {
    Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
  }
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  if (opts?.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  const res = await fetch(`${STRIPE_API_BASE}${path}`, {
    method,
    headers,
    ...(body ? { body } : {}),
  })
  const requestId = res.headers.get('request-id')
  const json = await res.json()
  return appendRequestId(json, requestId)
}

/** Retrieve a Stripe Issuing cardholder. */
export const getIssuingCardholder = (id: string) =>
  stripeRequest('GET', `/issuing/cardholders/${pathSegment(id)}`)

/** List Stripe Issuing cardholders. */
export const listIssuingCardholders = (params?: ListParams) =>
  stripeRequest('GET', '/issuing/cardholders' + queryString(params))

/** Retrieve a Stripe Issuing card. */
export const getIssuingCard = (id: string) =>
  stripeRequest('GET', `/issuing/cards/${pathSegment(id)}`)

/** List Stripe Issuing cards. */
export const listIssuingCards = (params?: ListParams) =>
  stripeRequest('GET', '/issuing/cards' + queryString(params))

/** Update a Stripe Issuing card. */
export const updateIssuingCard = (id: string, data: {
  status?: 'active' | 'inactive' | 'canceled'
  cancellationReason?: 'lost' | 'stolen'
}) => {
  const body = new URLSearchParams()
  if (data.status) body.set('status', data.status)
  if (data.cancellationReason) body.set('cancellation_reason', data.cancellationReason)
  return stripeRequest('POST', `/issuing/cards/${pathSegment(id)}`, body)
}

/** Temporarily freeze a Stripe Issuing card by making it inactive. */
export const freezeIssuingCard = (id: string) =>
  updateIssuingCard(id, { status: 'inactive' })

/** Unfreeze a Stripe Issuing card by making it active. */
export const unfreezeIssuingCard = (id: string) =>
  updateIssuingCard(id, { status: 'active' })

/** Create a Stripe Issuing card backed by a crypto wallet. */
export const createIssuingCard = (data: {
  cardholder: string
  walletAddress: string
  idempotencyKey: string
  bridgeCustomerId?: string
}) => {
  const body = new URLSearchParams({
    cardholder: data.cardholder,
    currency: 'usd',
    type: 'virtual',
    status: 'active',
    'crypto_wallet[chain]': 'tempo',
    'crypto_wallet[currency]': 'usdc',
    'crypto_wallet[type]': 'standard',
    'crypto_wallet[address]': data.walletAddress,
    'metadata[tempo_wallet]': data.walletAddress,
  })
  if (data.bridgeCustomerId) body.set('metadata[bridge_customer_id]', data.bridgeCustomerId)
  return stripeRequest('POST', '/issuing/cards', body, { idempotencyKey: data.idempotencyKey })
}

/** Retrieve a Stripe Issuing transaction. */
export const getIssuingTransaction = (id: string) =>
  stripeRequest('GET', `/issuing/transactions/${pathSegment(id)}`)

/** List Stripe Issuing transactions. */
export const listIssuingTransactions = (params?: ListParams) =>
  stripeRequest('GET', '/issuing/transactions' + queryString(params))

/** Retrieve a Stripe Issuing authorization. */
export const getIssuingAuthorization = (id: string) =>
  stripeRequest('GET', `/issuing/authorizations/${pathSegment(id)}`)

/** List Stripe Issuing authorizations. */
export const listIssuingAuthorizations = (params?: ListParams) =>
  stripeRequest('GET', '/issuing/authorizations' + queryString(params))
