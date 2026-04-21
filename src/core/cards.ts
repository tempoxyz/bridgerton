import { bridge } from './client.js'

/** Provision a card account for a customer. */
export const provisionCardAccount = (customerId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${customerId}/card_accounts`, data)

/** Retrieve a card account by ID. */
export const getCardAccount = (customerId: string, cardAccountId: string) =>
  bridge.get(`/customers/${customerId}/card_accounts/${cardAccountId}`)

/** Get all card accounts for a customer. */
export const listCardAccounts = (customerId: string) =>
  bridge.get(`/customers/${customerId}/card_accounts`)

/** Update a card account (change settlement currency or close). */
export const updateCardAccount = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.put(`/customers/${customerId}/card_accounts/${cardAccountId}`, data)

/** Place a freeze on a card account. */
export const freezeCardAccount = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${customerId}/card_accounts/${cardAccountId}/freeze`, data)

/** Remove a freeze from a card account. */
export const unfreezeCardAccount = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${customerId}/card_accounts/${cardAccountId}/unfreeze`, data)

/** Retrieve completed card transactions. */
export const listCardTransactions = (customerId: string, cardAccountId: string) =>
  bridge.get(`/customers/${customerId}/card_accounts/${cardAccountId}/transactions`)

/** Retrieve a single card transaction. */
export const getCardTransaction = (customerId: string, cardAccountId: string, transactionId: string) =>
  bridge.get(`/customers/${customerId}/card_accounts/${cardAccountId}/transactions/${transactionId}`)

/** Retrieve pending card authorizations. */
export const listCardAuthorizations = (customerId: string, cardAccountId: string) =>
  bridge.get(`/customers/${customerId}/card_accounts/${cardAccountId}/authorizations`)

/** Retrieve authorization controls (spend limits). */
export const getAuthorizationControls = (customerId: string, cardAccountId: string) =>
  bridge.get(`/customers/${customerId}/card_accounts/${cardAccountId}/authorization_controls`)

/** Create a funds withdrawal from a top-up card account. */
export const createCardWithdrawal = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${customerId}/card_accounts/${cardAccountId}/withdrawals`, data)

/** Retrieve withdrawal history for a top-up card account. */
export const listCardWithdrawals = (customerId: string, cardAccountId: string) =>
  bridge.get(`/customers/${customerId}/card_accounts/${cardAccountId}/withdrawals`)

/** Retrieve a single card withdrawal. */
export const getCardWithdrawal = (customerId: string, cardAccountId: string, withdrawalId: string) =>
  bridge.get(`/customers/${customerId}/card_accounts/${cardAccountId}/withdrawals/${withdrawalId}`)

/** Provision an additional top-up deposit address. */
export const addDepositAddress = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${customerId}/card_accounts/${cardAccountId}/deposit_addresses`, data)

/** Create a mobile wallet push provisioning request. */
export const createMobileWalletProvisioningRequest = (customerId: string, cardAccountId: string, data: Record<string, unknown>) =>
  bridge.post(`/customers/${customerId}/card_accounts/${cardAccountId}/create_mobile_wallet_provisioning_request`, data)

/** Get card designs for your card program. */
export const listCardDesigns = () =>
  bridge.get('/card_designs')

/** Get a summary of your card program. */
export const getCardProgramSummary = (params?: Record<string, string>) =>
  bridge.get('/card_program/summary', params)
