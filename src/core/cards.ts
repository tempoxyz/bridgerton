import { bridge } from './client.js'

const pathSegment = (value: string) => encodeURIComponent(value)

/** Retrieve a card account by ID. */
export const getCardAccount = (customerId: string, cardAccountId: string) =>
  bridge.get(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}`)

/** Get all card accounts for a customer. */
export const listCardAccounts = (customerId: string) =>
  bridge.get(`/customers/${pathSegment(customerId)}/card_accounts`)

/** Update a card account (change settlement currency or close). */
export const updateCardAccount = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.put(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}`, data)

/** Place a freeze on a card account. */
export const freezeCardAccount = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/freeze`, data)

/** Remove a freeze from a card account. */
export const unfreezeCardAccount = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/unfreeze`, data)

/** Create a card PIN update URL. */
export const createCardPinUpdateUrl = (customerId: string, cardAccountId: string) =>
  bridge.post(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/pin`)

/** Generate an ephemeral key to reveal card details. */
export const createCardEphemeralKey = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/ephemeral_keys`, data)

/** Generate a card account statement PDF. */
export const createCardStatement = (customerId: string, cardAccountId: string, period: string) =>
  bridge.downloadPost(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/statements/${pathSegment(period)}.pdf`)

/** Generate a card statement PDF using Stripe IDs. */
export const createStripeCardStatement = (cardholderId: string, cardId: string, period: string) =>
  bridge.downloadPost(`/cardholders/${pathSegment(cardholderId)}/cards/${pathSegment(cardId)}/statements/${pathSegment(period)}.pdf`)

/** Retrieve completed card transactions. */
export const listCardTransactions = (customerId: string, cardAccountId: string) =>
  bridge.get(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/transactions`)

/** Retrieve a single card transaction. */
export const getCardTransaction = (customerId: string, cardAccountId: string, transactionId: string) =>
  bridge.get(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/transactions/${pathSegment(transactionId)}`)

/** Retrieve pending card authorizations. */
export const listCardAuthorizations = (customerId: string, cardAccountId: string) =>
  bridge.get(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/authorizations`)

/** Retrieve authorization controls (spend limits). */
export const getAuthorizationControls = (customerId: string, cardAccountId: string) =>
  bridge.get(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/auth_controls`)

/** Create a funds withdrawal from a top-up card account. */
export const createCardWithdrawal = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/withdrawals`, data)

/** Retrieve withdrawal history for a top-up card account. */
export const listCardWithdrawals = (customerId: string, cardAccountId: string) =>
  bridge.get(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/withdrawals`)

/** Retrieve a single card withdrawal. */
export const getCardWithdrawal = (customerId: string, cardAccountId: string, withdrawalId: string) =>
  bridge.get(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/withdrawals/${pathSegment(withdrawalId)}`)

/** Provision an additional top-up deposit address. */
export const addDepositAddress = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/deposit_addresses`, data)

/** Create a mobile wallet push provisioning request. */
export const createMobileWalletProvisioningRequest = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${pathSegment(customerId)}/card_accounts/${pathSegment(cardAccountId)}/create_mobile_wallet_provisioning_request`, data)

/** Get card designs for your card program. */
export const listCardDesigns = () =>
  bridge.get('/developer/cards/designs')

/** Get a summary of your card program. */
export const getCardProgramSummary = (params: Record<string, string>) =>
  bridge.get('/developer/cards/summary', params)
