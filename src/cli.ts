import { chmodSync, writeFileSync } from 'node:fs'
import { Cli, z } from 'incur'
import { createCustomer, getCustomer, listCustomers, updateCustomer, deleteCustomer, createTosLink, getKycLink, getTosAcceptanceLink, listCustomerTransfers } from './core/customers.js'
import { createWallet, getWallet, listWallets, listAllWallets, getWalletTotalBalances, getWalletHistory } from './core/wallets.js'
import { createTransfer, getTransfer, listTransfers, updateTransfer, deleteTransfer, listStaticTemplates } from './core/transfers.js'
import { createLiquidation, getLiquidation, listLiquidations, listDrains, updateLiquidation, listAllDrains } from './core/liquidation.js'
import { createExternalAccount, getExternalAccount, listExternalAccounts, deleteExternalAccount } from './core/external-accounts.js'
import { createVirtualAccount, getVirtualAccount, listVirtualAccounts, listAllVirtualAccounts, updateVirtualAccount, deactivateVirtualAccount, reactivateVirtualAccount, getVirtualAccountActivity, getAllVirtualAccountActivity } from './core/virtual-accounts.js'
import { getExchangeRates } from './core/exchange-rates.js'
import { runPlaidLinkFlow } from './core/plaid-link.js'
import { listPrefundedAccounts, getPrefundedAccount, getPrefundedAccountHistory } from './core/prefunded-accounts.js'
import { getCardAccount, listCardAccounts, updateCardAccount, freezeCardAccount, unfreezeCardAccount, createCardPinUpdateUrl, createCardEphemeralKey, createCardStatement, createStripeCardStatement, listCardTransactions, getCardTransaction, listCardAuthorizations, getAuthorizationControls, createCardWithdrawal, listCardWithdrawals, getCardWithdrawal, addDepositAddress, createMobileWalletProvisioningRequest, listCardDesigns, getCardProgramSummary } from './core/cards.js'
import { getIssuingCardholder, listIssuingCardholders, getIssuingCard, listIssuingCards, updateIssuingCard, freezeIssuingCard, unfreezeIssuingCard, createIssuingCard, getIssuingTransaction, listIssuingTransactions, getIssuingAuthorization, listIssuingAuthorizations } from './core/stripe.js'
import { writeConfig, getApiKey, getStripeApiKey, getDefaultFormat, maskSecret } from './core/client.js'
import { runProfile, runReturnFunds, summarizeResults, TEMPO_USDC_E_TOKEN_ADDRESS } from './core/profile.js'
import pkg from '../package.json' with { type: 'json' }

const cli = Cli.create('bridgerton', {
  version: pkg.version,
  description: 'Bridge.xyz stablecoin infrastructure CLI. Built with incur.',
  format: getDefaultFormat() as 'toon' | 'json' | 'yaml' | 'md' | 'jsonl' | undefined,
  sync: {
    suggestions: [
      'create a wallet on tempo for a customer',
      'list all transfers',
      'create a static transfer template',
      'create a liquidation address on tempo',
      'check exchange rates',
      'create a Stripe virtual card backed by a Tempo wallet',
    ],
  },
})

function saveDownloadedFile(output: string, download: { body: Buffer; contentType: string | null; contentDisposition: string | null }) {
  writeFileSync(output, download.body, { mode: 0o600 })
  chmodSync(output, 0o600)
  return {
    saved: true,
    output,
    content_type: download.contentType,
    content_disposition: download.contentDisposition,
    bytes: download.body.byteLength,
  }
}

type TransferCreateOptions = {
  onBehalfOf: string
  sourceRail: string
  sourceCurrency: string
  destRail: string
  destCurrency: string
  destAddress?: string | undefined
  destWalletId?: string | undefined
  amount?: string | undefined
  flexibleAmount?: boolean | undefined
  staticTemplate?: boolean | undefined
  allowAnyFromAddress?: boolean | undefined
  sourceAddress?: string | undefined
  sourceWalletId?: string | undefined
  externalAccountId?: string | undefined
  clientReferenceId?: string | undefined
  developerFee?: string | undefined
  developerFeePercent?: string | undefined
}

function transferListParams(options: {
  limit?: string | undefined
  startingAfter?: string | undefined
  endingBefore?: string | undefined
  txHash?: string | undefined
  updatedAfterMs?: string | undefined
  updatedBeforeMs?: string | undefined
  templateId?: string | undefined
  state?: string | undefined
}) {
  const params: Record<string, string> = {}
  if (options.limit) params.limit = options.limit
  if (options.startingAfter) params.starting_after = options.startingAfter
  if (options.endingBefore) params.ending_before = options.endingBefore
  if (options.txHash) params.tx_hash = options.txHash
  if (options.updatedAfterMs) params.updated_after_ms = options.updatedAfterMs
  if (options.updatedBeforeMs) params.updated_before_ms = options.updatedBeforeMs
  if (options.templateId) params.template_id = options.templateId
  if (options.state) params.state = options.state
  return Object.keys(params).length ? params : undefined
}

function buildTransferBody(options: TransferCreateOptions, forceStaticTemplate = false) {
  const {
    onBehalfOf,
    sourceRail,
    sourceCurrency,
    destRail,
    destCurrency,
    destAddress,
    destWalletId,
    amount,
    flexibleAmount,
    staticTemplate,
    allowAnyFromAddress,
    sourceAddress,
    sourceWalletId,
    externalAccountId,
    clientReferenceId,
    developerFee,
    developerFeePercent,
  } = options
  if (destAddress && destWalletId) {
    throw new Error('Use either --dest-address or --dest-wallet-id, not both')
  }
  if (developerFee && developerFeePercent) {
    throw new Error('Use either --developer-fee or --developer-fee-percent, not both')
  }

  const body: any = {
    on_behalf_of: onBehalfOf,
    source: { payment_rail: sourceRail, currency: sourceCurrency },
    destination: { payment_rail: destRail, currency: destCurrency },
  }
  if (destAddress) body.destination.to_address = destAddress
  if (destWalletId) body.destination.bridge_wallet_id = destWalletId
  if (amount) body.amount = amount
  if (sourceAddress) body.source.from_address = sourceAddress
  if (sourceWalletId) body.source.bridge_wallet_id = sourceWalletId
  if (externalAccountId) body.source.external_account_id = externalAccountId
  if (clientReferenceId) body.client_reference_id = clientReferenceId
  if (developerFee) body.developer_fee = developerFee
  if (developerFeePercent) body.developer_fee_percent = developerFeePercent

  const features: Record<string, boolean> = {}
  if (flexibleAmount) features.flexible_amount = true
  if (allowAnyFromAddress) features.allow_any_from_address = true
  if (staticTemplate || forceStaticTemplate) features.static_template = true
  if (Object.keys(features).length) body.features = features

  return body
}

// --- customers subcommand group ---
const customers = Cli.create('customers', { description: 'Manage Bridge customers (KYC/KYB).' })

customers.command('create', {
  description: 'Create a new customer',
  options: z.object({
    type: z.enum(['individual', 'business']).default('individual').describe('Customer type'),
    firstName: z.string().describe('First name'),
    lastName: z.string().describe('Last name'),
    email: z.string().describe('Email address'),
  }),
  alias: { type: 't', firstName: 'f', lastName: 'l', email: 'e' },
  async run(c) {
    const { type, firstName, lastName, email } = c.options
    return createCustomer({ type, first_name: firstName, last_name: lastName, email })
  },
})

customers.command('get', {
  description: 'Get a customer by ID',
  args: z.object({ id: z.string().describe('Customer ID') }),
  async run(c) { return getCustomer(c.args.id) },
})

customers.command('list', {
  description: 'List all customers',
  async run() { return listCustomers() },
})

customers.command('update', {
  description: 'Update a customer',
  args: z.object({ id: z.string().describe('Customer ID') }),
  options: z.object({
    firstName: z.string().optional().describe('First name'),
    lastName: z.string().optional().describe('Last name'),
    email: z.string().optional().describe('Email address'),
  }),
  async run(c) {
    const body: any = {}
    if (c.options.firstName) body.first_name = c.options.firstName
    if (c.options.lastName) body.last_name = c.options.lastName
    if (c.options.email) body.email = c.options.email
    return updateCustomer(c.args.id, body)
  },
})

customers.command('delete', {
  description: 'Delete a customer',
  args: z.object({ id: z.string().describe('Customer ID') }),
  async run(c) { return deleteCustomer(c.args.id) },
})

customers.command('tos-link', {
  description: 'Create a hosted ToS acceptance link for new customer creation',
  async run() { return createTosLink() },
})

customers.command('kyc-link', {
  description: 'Get a hosted KYC link for an existing customer',
  args: z.object({ id: z.string().describe('Customer ID') }),
  options: z.object({
    endorsement: z.string().optional().describe('Endorsement type (sepa, spei, cards)'),
    redirectUri: z.string().optional().describe('Redirect URI after KYC completion'),
  }),
  async run(c) {
    const params: Record<string, string> = {}
    if (c.options.endorsement) params.endorsement = c.options.endorsement
    if (c.options.redirectUri) params.redirect_uri = c.options.redirectUri
    return getKycLink(c.args.id, Object.keys(params).length ? params : undefined)
  },
})

customers.command('tos-acceptance-link', {
  description: 'Get a hosted ToS acceptance link for an existing customer',
  args: z.object({ id: z.string().describe('Customer ID') }),
  async run(c) { return getTosAcceptanceLink(c.args.id) },
})

customers.command('transfers', {
  description: 'List transfers for a customer',
  args: z.object({ id: z.string().describe('Customer ID') }),
  async run(c) { return listCustomerTransfers(c.args.id) },
})

cli.command(customers)

// --- wallets subcommand group ---
const wallets = Cli.create('wallets', { description: 'Manage custodial wallets.' })

wallets.command('create', {
  description: 'Create a wallet for a customer',
  args: z.object({ customerId: z.string().describe('Customer ID') }),
  options: z.object({
    chain: z.string().default('tempo').describe('Blockchain (base, ethereum, solana, tron, tempo)'),
  }),
  alias: { chain: 'c' },
  async run(c) { return createWallet(c.args.customerId, { chain: c.options.chain }) },
})

wallets.command('get', {
  description: 'Get a wallet',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    walletId: z.string().describe('Wallet ID'),
  }),
  async run(c) { return getWallet(c.args.customerId, c.args.walletId) },
})

wallets.command('list', {
  description: 'List wallets for a customer',
  args: z.object({ customerId: z.string().describe('Customer ID') }),
  async run(c) { return listWallets(c.args.customerId) },
})

wallets.command('list-all', {
  description: 'List all wallets across all customers',
  async run() { return listAllWallets() },
})

wallets.command('total-balances', {
  description: 'Get total balances across all wallets',
  async run() { return getWalletTotalBalances() },
})

wallets.command('history', {
  description: 'Get transaction history for a wallet',
  args: z.object({ walletId: z.string().describe('Wallet ID') }),
  async run(c) { return getWalletHistory(c.args.walletId) },
})

cli.command(wallets)

// --- transfers subcommand group ---
const transfers = Cli.create('transfers', { description: 'Create and manage transfers (on-ramp, off-ramp, crypto-to-crypto).' })

transfers.command('create', {
  description: 'Create a transfer',
  options: z.object({
    onBehalfOf: z.string().describe('Customer ID'),
    sourceRail: z.string().describe('Source payment rail (ach_push, wire, bridge_wallet, ethereum, solana, etc.)'),
    sourceCurrency: z.string().describe('Source currency (usd, usdc, usdb, etc.)'),
    destRail: z.string().describe('Destination payment rail'),
    destCurrency: z.string().describe('Destination currency'),
    destAddress: z.string().optional().describe('Destination blockchain address'),
    destWalletId: z.string().optional().describe('Destination Bridge wallet ID (when sending to a Bridge wallet)'),
    amount: z.string().optional().describe('Transfer amount'),
    flexibleAmount: z.boolean().optional().default(false).describe('Allow any deposit amount'),
    staticTemplate: z.boolean().optional().default(false).describe('Create reusable static transfer template deposit instructions'),
    allowAnyFromAddress: z.boolean().optional().default(false).describe('Allow crypto deposits from any source address'),
    sourceAddress: z.string().optional().describe('Source blockchain address expected to send funds'),
    sourceWalletId: z.string().optional().describe('Source Bridge wallet ID (when source rail is bridge_wallet)'),
    externalAccountId: z.string().optional().describe('External account ID (for off-ramps)'),
    clientReferenceId: z.string().optional().describe('Client reference ID'),
    developerFee: z.string().optional().describe('Fixed developer fee'),
    developerFeePercent: z.string().optional().describe('Developer fee percent'),
  }),
  async run(c) {
    return createTransfer(buildTransferBody(c.options))
  },
})

transfers.command('get', {
  description: 'Get a transfer by ID',
  args: z.object({ id: z.string().describe('Transfer ID') }),
  async run(c) { return getTransfer(c.args.id) },
})

transfers.command('list', {
  description: 'List all transfers',
  options: z.object({
    limit: z.string().optional().describe('Maximum number of transfers to return (1-100)'),
    startingAfter: z.string().optional().describe('Pagination cursor'),
    endingBefore: z.string().optional().describe('Pagination cursor'),
    txHash: z.string().optional().describe('Filter by transaction hash'),
    updatedAfterMs: z.string().optional().describe('Only transfers updated after this Unix timestamp in milliseconds'),
    updatedBeforeMs: z.string().optional().describe('Only transfers updated before this Unix timestamp in milliseconds'),
    templateId: z.string().optional().describe('Filter transfers created from a static template ID'),
    state: z.string().optional().describe('Filter transfers by state'),
  }),
  async run(c) { return listTransfers(transferListParams(c.options)) },
})

const staticTemplates = Cli.create('static-templates', { description: 'Manage static transfer templates (saved payment routes).' })

staticTemplates.command('create', {
  description: 'Create a static transfer template with reusable deposit instructions',
  options: z.object({
    onBehalfOf: z.string().describe('Customer ID'),
    sourceRail: z.string().describe('Source payment rail (ach_push, wire, ethereum, tempo, etc.)'),
    sourceCurrency: z.string().describe('Source currency (usd, usdc, usdb, etc.)'),
    destRail: z.string().describe('Destination payment rail'),
    destCurrency: z.string().describe('Destination currency'),
    destAddress: z.string().optional().describe('Destination blockchain address'),
    destWalletId: z.string().optional().describe('Destination Bridge wallet ID'),
    amount: z.string().optional().describe('Optional fixed transfer amount'),
    flexibleAmount: z.boolean().optional().default(false).describe('Allow any deposit amount'),
    allowAnyFromAddress: z.boolean().optional().default(false).describe('Allow crypto deposits from any source address'),
    sourceAddress: z.string().optional().describe('Source blockchain address expected to send funds'),
    sourceWalletId: z.string().optional().describe('Source Bridge wallet ID (when source rail is bridge_wallet)'),
    externalAccountId: z.string().optional().describe('External account ID (for off-ramps)'),
    clientReferenceId: z.string().optional().describe('Client reference ID'),
    developerFee: z.string().optional().describe('Fixed developer fee'),
    developerFeePercent: z.string().optional().describe('Developer fee percent'),
  }),
  async run(c) {
    return createTransfer(buildTransferBody(c.options, true))
  },
})

staticTemplates.command('list', {
  description: 'List static transfer templates',
  options: z.object({
    limit: z.string().optional().describe('Maximum number of templates to return (1-100)'),
    startingAfter: z.string().optional().describe('Pagination cursor'),
    endingBefore: z.string().optional().describe('Pagination cursor'),
  }),
  async run(c) {
    return listStaticTemplates(transferListParams(c.options))
  },
})

staticTemplates.command('get', {
  description: 'Get a static transfer template by ID',
  args: z.object({ id: z.string().describe('Static template transfer ID') }),
  async run(c) { return getTransfer(c.args.id) },
})

staticTemplates.command('instances', {
  description: 'List transfer instances created from a static template',
  args: z.object({ id: z.string().describe('Static template transfer ID') }),
  options: z.object({
    limit: z.string().optional().describe('Maximum number of transfers to return (1-100)'),
    startingAfter: z.string().optional().describe('Pagination cursor'),
    endingBefore: z.string().optional().describe('Pagination cursor'),
    state: z.string().optional().describe('Filter transfer instances by state'),
  }),
  async run(c) {
    return listTransfers(transferListParams({ ...c.options, templateId: c.args.id }))
  },
})

staticTemplates.command('update', {
  description: 'Update an awaiting static transfer template',
  args: z.object({ id: z.string().describe('Static template transfer ID') }),
  options: z.object({
    amount: z.string().optional().describe('Transfer amount'),
    developerFee: z.string().optional().describe('Fixed developer fee'),
    developerFeePercent: z.string().optional().describe('Developer fee percent'),
  }),
  async run(c) {
    const body: Record<string, unknown> = {}
    if (c.options.amount) body.amount = c.options.amount
    if (c.options.developerFee) body.developer_fee = c.options.developerFee
    if (c.options.developerFeePercent) body.developer_fee_percent = c.options.developerFeePercent
    return updateTransfer(c.args.id, body)
  },
})

staticTemplates.command('delete', {
  description: 'Cancel an awaiting static transfer template',
  args: z.object({ id: z.string().describe('Static template transfer ID') }),
  async run(c) { return deleteTransfer(c.args.id) },
})

transfers.command(staticTemplates)

cli.command(transfers)

// --- liquidation subcommand group ---
const liquidation = Cli.create('liquidation', { description: 'Manage liquidation addresses.' })

liquidation.command('create', {
  description: 'Create a liquidation address',
  args: z.object({ customerId: z.string().describe('Customer ID') }),
  options: z.object({
    chain: z.string().default('tempo').describe('Blockchain'),
    currency: z.string().default('usdc').describe('Source currency (usdc, usdb, usdt, dai, pyusd, eurc)'),
    destinationAddress: z.string().optional().describe('Crypto destination address'),
    externalAccountId: z.string().optional().describe('External bank account ID (for fiat off-ramp)'),
    walletId: z.string().optional().describe('Bridge wallet ID destination'),
    destRail: z.string().optional().describe('Destination payment rail'),
    destCurrency: z.string().optional().describe('Destination currency'),
    feePercent: z.string().optional().describe('Developer fee percent (e.g. "1.0")'),
    returnAddress: z.string().optional().describe('Crypto address for returns if deposit cannot be delivered'),
  }),
  async run(c) {
    const { chain, currency, destinationAddress, externalAccountId, walletId, destRail, destCurrency, feePercent, returnAddress } = c.options
    const body: any = { chain, currency }
    if (destinationAddress) body.destination_address = destinationAddress
    if (externalAccountId) body.external_account_id = externalAccountId
    if (walletId) body.bridge_wallet_id = walletId
    if (destRail) body.destination_payment_rail = destRail
    if (destCurrency) body.destination_currency = destCurrency
    if (feePercent) body.custom_developer_fee_percent = feePercent
    if (returnAddress) body.return_address = returnAddress
    return createLiquidation(c.args.customerId, body)
  },
})

liquidation.command('get', {
  description: 'Get a liquidation address',
  args: z.object({ id: z.string().describe('Liquidation address ID') }),
  async run(c) { return getLiquidation(c.args.id) },
})

liquidation.command('list', {
  description: 'List liquidation addresses for a customer',
  args: z.object({ customerId: z.string().describe('Customer ID') }),
  async run(c) { return listLiquidations(c.args.customerId) },
})

liquidation.command('drains', {
  description: 'List drain history for a liquidation address',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    liquidationAddressId: z.string().describe('Liquidation address ID'),
  }),
  async run(c) { return listDrains(c.args.customerId, c.args.liquidationAddressId) },
})

liquidation.command('update', {
  description: 'Update a liquidation address',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    liquidationAddressId: z.string().describe('Liquidation address ID'),
  }),
  options: z.object({
    externalAccountId: z.string().optional().describe('External account ID'),
    feePercent: z.string().optional().describe('Developer fee percent (e.g. "1.0")'),
    returnAddress: z.string().optional().describe('Crypto return address'),
  }),
  async run(c) {
    const body: any = {}
    if (c.options.externalAccountId) body.external_account_id = c.options.externalAccountId
    if (c.options.feePercent) body.custom_developer_fee_percent = c.options.feePercent
    if (c.options.returnAddress) body.return_address = c.options.returnAddress
    return updateLiquidation(c.args.customerId, c.args.liquidationAddressId, body)
  },
})

liquidation.command('all-drains', {
  description: 'List drain activity across all customers',
  async run() { return listAllDrains() },
})

cli.command(liquidation)

// --- external-accounts subcommand group ---
const externalAccounts = Cli.create('external-accounts', { description: 'Manage external bank accounts.' })

externalAccounts.command('create', {
  description: 'Add an external account (US ACH) manually or with Plaid.',
  args: z.object({ customerId: z.string().describe('Customer ID') }),
  options: z.object({
    accountNumber: z.string().optional().describe('Bank account number (omit to use Plaid Link)'),
    routingNumber: z.string().optional().describe('Bank routing number, 9 digits (omit to use Plaid Link)'),
    accountOwnerName: z.string().optional().describe('Account owner name (omit to use Plaid Link)'),
    checkingOrSavings: z.enum(['checking', 'savings']).default('checking').describe('Checking or savings'),
    bankName: z.string().optional().describe('Bank name'),
    firstName: z.string().optional().describe('Account holder first name'),
    lastName: z.string().optional().describe('Account holder last name'),
    businessName: z.string().optional().describe('Business name (for business accounts)'),
    street: z.string().optional().describe('Street address'),
    city: z.string().optional().describe('City'),
    state: z.string().optional().describe('State (2-letter code)'),
    postalCode: z.string().optional().describe('Postal/ZIP code'),
    country: z.string().default('USA').describe('Country code (3-letter ISO, e.g. USA)'),
  }),
  async run(c) {
    const { accountNumber, routingNumber, accountOwnerName, checkingOrSavings, bankName, firstName, lastName, businessName, street, city, state, postalCode, country } = c.options
    if (!accountNumber && !routingNumber && !accountOwnerName) return runPlaidLinkFlow(c.args.customerId)
    if (!accountNumber || !routingNumber || !accountOwnerName) {
      throw new Error('--accountNumber, --routingNumber, and --accountOwnerName are all required for manual creation')
    }
    const body: any = {
      currency: 'usd',
      account_type: 'us',
      account_owner_name: accountOwnerName,
      account: {
        account_number: accountNumber,
        routing_number: routingNumber,
        checking_or_savings: checkingOrSavings,
      },
    }
    if (bankName) body.bank_name = bankName
    if (firstName) body.first_name = firstName
    if (lastName) body.last_name = lastName
    if (businessName) body.business_name = businessName
    if (street || city || state || postalCode) {
      body.address = { country }
      if (street) body.address.street_line_1 = street
      if (city) body.address.city = city
      if (state) body.address.state = state
      if (postalCode) body.address.postal_code = postalCode
    }
    return createExternalAccount(c.args.customerId, body)
  },
})

externalAccounts.command('get', {
  description: 'Get an external account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    externalAccountId: z.string().describe('External account ID'),
  }),
  async run(c) { return getExternalAccount(c.args.customerId, c.args.externalAccountId) },
})

externalAccounts.command('list', {
  description: 'List external accounts for a customer',
  args: z.object({ customerId: z.string().describe('Customer ID') }),
  async run(c) { return listExternalAccounts(c.args.customerId) },
})

externalAccounts.command('delete', {
  description: 'Delete (deactivate) an external account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    externalAccountId: z.string().describe('External account ID'),
  }),
  async run(c) { return deleteExternalAccount(c.args.customerId, c.args.externalAccountId) },
})

cli.command(externalAccounts)

// --- virtual-accounts subcommand group ---
const virtualAccounts = Cli.create('virtual-accounts', { description: 'Manage virtual accounts (fiat deposit addresses).' })

virtualAccounts.command('create', {
  description: 'Create a virtual account',
  args: z.object({ customerId: z.string().describe('Customer ID') }),
  options: z.object({
    sourceCurrency: z.string().default('usd').describe('Source fiat currency (usd, eur, mxn, brl, gbp)'),
    destRail: z.string().default('ethereum').describe('Destination blockchain'),
    destCurrency: z.string().default('usdc').describe('Destination stablecoin'),
    destAddress: z.string().describe('Destination blockchain address'),
    feePercent: z.string().optional().describe('Developer fee percent'),
  }),
  async run(c) {
    const { sourceCurrency, destRail, destCurrency, destAddress, feePercent } = c.options
    const body: any = {
      source: { currency: sourceCurrency },
      destination: { payment_rail: destRail, currency: destCurrency, address: destAddress },
    }
    if (feePercent) body.developer_fee_percent = feePercent
    return createVirtualAccount(c.args.customerId, body)
  },
})

virtualAccounts.command('get', {
  description: 'Get a virtual account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    id: z.string().describe('Virtual account ID'),
  }),
  async run(c) { return getVirtualAccount(c.args.customerId, c.args.id) },
})

virtualAccounts.command('list', {
  description: 'List virtual accounts for a customer',
  args: z.object({ customerId: z.string().describe('Customer ID') }),
  async run(c) { return listVirtualAccounts(c.args.customerId) },
})

virtualAccounts.command('list-all', {
  description: 'List all virtual accounts across all customers',
  async run() { return listAllVirtualAccounts() },
})

virtualAccounts.command('update', {
  description: 'Update a virtual account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    id: z.string().describe('Virtual account ID'),
  }),
  options: z.object({
    destRail: z.string().optional().describe('Destination blockchain'),
    destCurrency: z.string().optional().describe('Destination stablecoin'),
    destAddress: z.string().optional().describe('Destination blockchain address'),
    feePercent: z.string().optional().describe('Developer fee percent'),
  }),
  async run(c) {
    const body: any = {}
    const dest: any = {}
    if (c.options.destRail) dest.payment_rail = c.options.destRail
    if (c.options.destCurrency) dest.currency = c.options.destCurrency
    if (c.options.destAddress) dest.address = c.options.destAddress
    if (Object.keys(dest).length) body.destination = dest
    if (c.options.feePercent) body.developer_fee_percent = c.options.feePercent
    return updateVirtualAccount(c.args.customerId, c.args.id, body)
  },
})

virtualAccounts.command('deactivate', {
  description: 'Deactivate a virtual account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    id: z.string().describe('Virtual account ID'),
  }),
  async run(c) { return deactivateVirtualAccount(c.args.customerId, c.args.id) },
})

virtualAccounts.command('reactivate', {
  description: 'Reactivate a virtual account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    id: z.string().describe('Virtual account ID'),
  }),
  async run(c) { return reactivateVirtualAccount(c.args.customerId, c.args.id) },
})

virtualAccounts.command('activity', {
  description: 'Get activity history for a virtual account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    id: z.string().describe('Virtual account ID'),
  }),
  async run(c) { return getVirtualAccountActivity(c.args.customerId, c.args.id) },
})

virtualAccounts.command('all-activity', {
  description: 'Get activity history across all virtual accounts',
  async run() { return getAllVirtualAccountActivity() },
})

cli.command(virtualAccounts)

// --- prefunded-accounts subcommand group ---
const prefundedAccounts = Cli.create('prefunded-accounts', { description: 'Manage prefunded accounts.' })

prefundedAccounts.command('list', {
  description: 'List all prefunded accounts',
  async run() { return listPrefundedAccounts() },
})

prefundedAccounts.command('get', {
  description: 'Get a prefunded account',
  args: z.object({ id: z.string().describe('Prefunded account ID') }),
  async run(c) { return getPrefundedAccount(c.args.id) },
})

prefundedAccounts.command('history', {
  description: 'Get funding history for a prefunded account',
  args: z.object({ id: z.string().describe('Prefunded account ID') }),
  async run(c) { return getPrefundedAccountHistory(c.args.id) },
})

cli.command(prefundedAccounts)

// --- cards subcommand group ---
const cards = Cli.create('cards', { description: 'Manage Tempo wallet-backed Stripe Issuing cards.' })

cards.command('create', {
  description: 'Create a virtual Stripe Issuing card backed by a Tempo wallet',
  options: z.object({
    cardholder: z.string().describe('Stripe Issuing cardholder ID'),
    walletAddress: z.string().describe('Tempo wallet address backing the card; must be unique to this customer'),
    idempotencyKey: z.string().describe('Stripe idempotency key for safe retries'),
    bridgeCustomerId: z.string().optional().describe('Bridge customer ID to store in Stripe metadata'),
  }),
  async run(c) {
    const data: {
      cardholder: string
      walletAddress: string
      idempotencyKey: string
      bridgeCustomerId?: string
    } = {
      cardholder: c.options.cardholder,
      walletAddress: c.options.walletAddress,
      idempotencyKey: c.options.idempotencyKey,
    }
    if (c.options.bridgeCustomerId) data.bridgeCustomerId = c.options.bridgeCustomerId
    return createIssuingCard(data)
  },
})

cards.command('list', {
  description: 'List Stripe Issuing cards',
  options: z.object({
    cardholder: z.string().optional().describe('Only return cards belonging to this cardholder'),
    status: z.enum(['active', 'inactive', 'canceled']).optional().describe('Only return cards with this status'),
    type: z.enum(['virtual', 'physical']).optional().describe('Only return cards with this type'),
    last4: z.string().optional().describe('Only return cards with these last four digits'),
    limit: z.string().optional().describe('Maximum number of cards to return (1-100)'),
    startingAfter: z.string().optional().describe('Pagination cursor'),
    endingBefore: z.string().optional().describe('Pagination cursor'),
  }),
  async run(c) {
    return listIssuingCards({
      cardholder: c.options.cardholder,
      status: c.options.status,
      type: c.options.type,
      last4: c.options.last4,
      limit: c.options.limit ? Number(c.options.limit) : undefined,
      startingAfter: c.options.startingAfter,
      endingBefore: c.options.endingBefore,
    })
  },
})

cards.command('get', {
  description: 'Retrieve a Stripe Issuing card',
  args: z.object({ id: z.string().describe('Stripe Issuing card ID') }),
  async run(c) { return getIssuingCard(c.args.id) },
})

cards.command('update', {
  description: 'Update a Stripe Issuing card status',
  args: z.object({ id: z.string().describe('Stripe Issuing card ID') }),
  options: z.object({
    status: z.enum(['active', 'inactive', 'canceled']).describe('New card status'),
    cancellationReason: z.enum(['lost', 'stolen']).optional().describe('Required by Stripe when canceling a lost or stolen card'),
  }),
  async run(c) {
    const data: {
      status: 'active' | 'inactive' | 'canceled'
      cancellationReason?: 'lost' | 'stolen'
    } = { status: c.options.status }
    if (c.options.cancellationReason) data.cancellationReason = c.options.cancellationReason
    return updateIssuingCard(c.args.id, data)
  },
})

cards.command('freeze', {
  description: 'Freeze a Stripe Issuing card by setting status to inactive',
  args: z.object({ id: z.string().describe('Stripe Issuing card ID') }),
  async run(c) { return freezeIssuingCard(c.args.id) },
})

cards.command('unfreeze', {
  description: 'Unfreeze a Stripe Issuing card by setting status to active',
  args: z.object({ id: z.string().describe('Stripe Issuing card ID') }),
  async run(c) { return unfreezeIssuingCard(c.args.id) },
})

cards.command('cancel', {
  description: 'Cancel a Stripe Issuing card',
  args: z.object({ id: z.string().describe('Stripe Issuing card ID') }),
  options: z.object({
    cancellationReason: z.enum(['lost', 'stolen']).optional().describe('Reason when canceling a lost or stolen card'),
  }),
  async run(c) {
    const data: { status: 'canceled'; cancellationReason?: 'lost' | 'stolen' } = { status: 'canceled' }
    if (c.options.cancellationReason) data.cancellationReason = c.options.cancellationReason
    return updateIssuingCard(c.args.id, data)
  },
})

const cardholders = Cli.create('cardholders', { description: 'Manage Stripe Issuing cardholders.' })

cardholders.command('list', {
  description: 'List Stripe Issuing cardholders',
  options: z.object({
    email: z.string().optional().describe('Only return cardholders with this email'),
    status: z.enum(['active', 'inactive', 'blocked']).optional().describe('Only return cardholders with this status'),
    type: z.enum(['individual', 'company']).optional().describe('Only return cardholders with this type'),
    limit: z.string().optional().describe('Maximum number of cardholders to return (1-100)'),
    startingAfter: z.string().optional().describe('Pagination cursor'),
    endingBefore: z.string().optional().describe('Pagination cursor'),
  }),
  async run(c) {
    return listIssuingCardholders({
      email: c.options.email,
      status: c.options.status,
      type: c.options.type,
      limit: c.options.limit ? Number(c.options.limit) : undefined,
      startingAfter: c.options.startingAfter,
      endingBefore: c.options.endingBefore,
    })
  },
})

cardholders.command('get', {
  description: 'Retrieve a Stripe Issuing cardholder',
  args: z.object({ id: z.string().describe('Stripe Issuing cardholder ID') }),
  async run(c) { return getIssuingCardholder(c.args.id) },
})

cards.command(cardholders)

const transactions = Cli.create('transactions', { description: 'Manage Stripe Issuing transactions.' })

transactions.command('list', {
  description: 'List Stripe Issuing transactions',
  options: z.object({
    card: z.string().optional().describe('Only return transactions for this card'),
    cardholder: z.string().optional().describe('Only return transactions for this cardholder'),
    type: z.enum(['capture', 'refund']).optional().describe('Only return transactions with this type'),
    limit: z.string().optional().describe('Maximum number of transactions to return (1-100)'),
    startingAfter: z.string().optional().describe('Pagination cursor'),
    endingBefore: z.string().optional().describe('Pagination cursor'),
  }),
  async run(c) {
    return listIssuingTransactions({
      card: c.options.card,
      cardholder: c.options.cardholder,
      type: c.options.type,
      limit: c.options.limit ? Number(c.options.limit) : undefined,
      startingAfter: c.options.startingAfter,
      endingBefore: c.options.endingBefore,
    })
  },
})

transactions.command('get', {
  description: 'Retrieve a Stripe Issuing transaction',
  args: z.object({ id: z.string().describe('Stripe Issuing transaction ID') }),
  async run(c) { return getIssuingTransaction(c.args.id) },
})

cards.command(transactions)

const authorizations = Cli.create('authorizations', { description: 'Manage Stripe Issuing authorizations.' })

authorizations.command('list', {
  description: 'List Stripe Issuing authorizations',
  options: z.object({
    card: z.string().optional().describe('Only return authorizations for this card'),
    cardholder: z.string().optional().describe('Only return authorizations for this cardholder'),
    status: z.enum(['pending', 'closed', 'reversed', 'expired']).optional().describe('Only return authorizations with this status'),
    limit: z.string().optional().describe('Maximum number of authorizations to return (1-100)'),
    startingAfter: z.string().optional().describe('Pagination cursor'),
    endingBefore: z.string().optional().describe('Pagination cursor'),
  }),
  async run(c) {
    return listIssuingAuthorizations({
      card: c.options.card,
      cardholder: c.options.cardholder,
      status: c.options.status,
      limit: c.options.limit ? Number(c.options.limit) : undefined,
      startingAfter: c.options.startingAfter,
      endingBefore: c.options.endingBefore,
    })
  },
})

authorizations.command('get', {
  description: 'Retrieve a Stripe Issuing authorization',
  args: z.object({ id: z.string().describe('Stripe Issuing authorization ID') }),
  async run(c) { return getIssuingAuthorization(c.args.id) },
})

cards.command(authorizations)

const statements = Cli.create('statements', { description: 'Generate card statements.' })

statements.command('create', {
  description: 'Generate a card statement PDF using Stripe cardholder and card IDs',
  options: z.object({
    cardholder: z.string().describe('Stripe Issuing cardholder ID'),
    card: z.string().describe('Stripe Issuing card ID'),
    period: z.string().describe('Statement period in YYYYMM format'),
    output: z.string().describe('Path to write the statement PDF'),
  }),
  async run(c) {
    const download = await createStripeCardStatement(c.options.cardholder, c.options.card, c.options.period)
    return saveDownloadedFile(c.options.output, download)
  },
})

cards.command(statements)

cli.command(cards)

// --- bridge-cards subcommand group ---
const bridgeCards = Cli.create('bridge-cards', { description: 'Manage Bridge card account utility endpoints.' })

bridgeCards.command('list', {
  description: 'List Bridge card accounts for a customer',
  args: z.object({ customerId: z.string().describe('Customer ID') }),
  async run(c) { return listCardAccounts(c.args.customerId) },
})

bridgeCards.command('get', {
  description: 'Retrieve a Bridge card account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  async run(c) { return getCardAccount(c.args.customerId, c.args.cardAccountId) },
})

bridgeCards.command('update', {
  description: 'Update a Bridge card account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  options: z.object({
    currency: z.string().optional().describe('New settlement currency'),
    status: z.enum(['inactive']).optional().describe('Set to inactive to permanently close the card account'),
  }),
  async run(c) {
    const body: Record<string, unknown> = {}
    if (c.options.currency) body.currency = c.options.currency
    if (c.options.status) body.status = c.options.status
    return updateCardAccount(c.args.customerId, c.args.cardAccountId, body)
  },
})

bridgeCards.command('freeze', {
  description: 'Place a freeze on a Bridge card account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  options: z.object({
    initiator: z.enum(['developer', 'customer']).default('developer').describe('Freeze initiator'),
    reason: z.enum(['lost_or_stolen', 'suspicious_activity', 'planned_inactivity', 'suspected_fraud', 'other']).describe('Freeze reason'),
    reasonDetail: z.string().optional().describe('Detailed reason for the freeze'),
    startingAt: z.string().optional().describe('Start time for the freeze (ISO8601)'),
    endingAt: z.string().optional().describe('End time for the freeze (ISO8601)'),
  }),
  async run(c) {
    const body: Record<string, unknown> = { initiator: c.options.initiator, reason: c.options.reason }
    if (c.options.reasonDetail) body.reason_detail = c.options.reasonDetail
    if (c.options.startingAt) body.starting_at = c.options.startingAt
    if (c.options.endingAt) body.ending_at = c.options.endingAt
    return freezeCardAccount(c.args.customerId, c.args.cardAccountId, body)
  },
})

bridgeCards.command('unfreeze', {
  description: 'Remove a freeze from a Bridge card account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  options: z.object({
    initiator: z.enum(['developer', 'customer']).default('developer').describe('Initiator of the freeze to remove'),
  }),
  async run(c) {
    return unfreezeCardAccount(c.args.customerId, c.args.cardAccountId, { initiator: c.options.initiator })
  },
})

bridgeCards.command('pin-update-url', {
  description: 'Create a secure PIN update URL for a Bridge card account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  async run(c) { return createCardPinUpdateUrl(c.args.customerId, c.args.cardAccountId) },
})

bridgeCards.command('ephemeral-key', {
  description: 'Generate an ephemeral key to reveal Bridge card details',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  options: z.object({
    clientNonce: z.string().describe('Client-side nonce associated with the ephemeral key'),
  }),
  async run(c) {
    return createCardEphemeralKey(c.args.customerId, c.args.cardAccountId, { client_nonce: c.options.clientNonce })
  },
})

bridgeCards.command('statement', {
  description: 'Generate a Bridge card account statement PDF',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
    period: z.string().describe('Statement period in YYYYMM format'),
  }),
  options: z.object({
    output: z.string().describe('Path to write the statement PDF'),
  }),
  async run(c) {
    const download = await createCardStatement(c.args.customerId, c.args.cardAccountId, c.args.period)
    return saveDownloadedFile(c.options.output, download)
  },
})

bridgeCards.command('transactions', {
  description: 'List settled Bridge card transactions',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  async run(c) { return listCardTransactions(c.args.customerId, c.args.cardAccountId) },
})

bridgeCards.command('transaction', {
  description: 'Get a single Bridge card transaction',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
    transactionId: z.string().describe('Transaction ID'),
  }),
  async run(c) { return getCardTransaction(c.args.customerId, c.args.cardAccountId, c.args.transactionId) },
})

bridgeCards.command('authorizations', {
  description: 'List pending Bridge card authorizations',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  async run(c) { return listCardAuthorizations(c.args.customerId, c.args.cardAccountId) },
})

bridgeCards.command('authorization-controls', {
  description: 'Get spend limits for a Bridge card account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  async run(c) { return getAuthorizationControls(c.args.customerId, c.args.cardAccountId) },
})

bridgeCards.command('withdraw', {
  description: 'Create a funds withdrawal from a top-up Bridge card account',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  options: z.object({
    amount: z.string().describe('Withdrawal amount'),
    currency: z.string().default('usdc').describe('Currency'),
    destinationAddress: z.string().describe('Destination crypto address'),
    chain: z.string().describe('Destination chain'),
    memo: z.string().optional().describe('Destination memo'),
    clientNote: z.string().optional().describe('Client note for the withdrawal'),
  }),
  async run(c) {
    const destination: Record<string, unknown> = { address: c.options.destinationAddress, chain: c.options.chain }
    if (c.options.memo) destination.memo = c.options.memo
    const body: Record<string, unknown> = {
      amount: c.options.amount,
      currency: c.options.currency,
      destination,
    }
    if (c.options.clientNote) body.client_note = c.options.clientNote
    return createCardWithdrawal(c.args.customerId, c.args.cardAccountId, body)
  },
})

bridgeCards.command('withdrawals', {
  description: 'List Bridge card withdrawal history',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  async run(c) { return listCardWithdrawals(c.args.customerId, c.args.cardAccountId) },
})

bridgeCards.command('get-withdrawal', {
  description: 'Get a single Bridge card withdrawal',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
    withdrawalId: z.string().describe('Withdrawal ID'),
  }),
  async run(c) { return getCardWithdrawal(c.args.customerId, c.args.cardAccountId, c.args.withdrawalId) },
})

bridgeCards.command('add-deposit-address', {
  description: 'Add a top-up deposit address on another chain',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  options: z.object({
    chain: z.string().describe('Chain for the new deposit address'),
  }),
  async run(c) {
    return addDepositAddress(c.args.customerId, c.args.cardAccountId, { chain: c.options.chain })
  },
})

bridgeCards.command('mobile-provision', {
  description: 'Push-provision a Bridge card to Apple Pay or Google Pay',
  args: z.object({
    customerId: z.string().describe('Customer ID'),
    cardAccountId: z.string().describe('Card account ID'),
  }),
  options: z.object({
    walletProvider: z.enum(['apple_pay', 'google_pay']).describe('Mobile wallet provider'),
    encoding: z.enum(['hex', 'base64']).optional().describe('Apple Pay certificate and nonce encoding'),
    leafCert: z.string().optional().describe('Apple Pay leaf certificate'),
    subordinateCert: z.string().optional().describe('Apple Pay subordinate certificate'),
    certificates: z.string().optional().describe('Apple Pay: legacy comma-separated leaf and subordinate certificates'),
    nonce: z.string().optional().describe('Apple Pay: nonce value'),
    nonceSignature: z.string().optional().describe('Apple Pay: nonce signature'),
    clientWalletAccountId: z.string().optional().describe('Google Pay: client wallet account ID'),
    clientDeviceId: z.string().optional().describe('Google Pay: client device ID'),
  }),
  async run(c) {
    const body: Record<string, any> = { wallet_provider: c.options.walletProvider }
    if (c.options.walletProvider === 'apple_pay') {
      body.apple_pay = {}
      const [legacyLeafCert, legacySubordinateCert] = c.options.certificates?.split(',') ?? []
      if (c.options.encoding) body.apple_pay.encoding = c.options.encoding
      if (c.options.leafCert || legacyLeafCert) body.apple_pay.leaf_cert = c.options.leafCert ?? legacyLeafCert
      if (c.options.subordinateCert || legacySubordinateCert) body.apple_pay.subordinate_cert = c.options.subordinateCert ?? legacySubordinateCert
      if (c.options.nonce) body.apple_pay.nonce = c.options.nonce
      if (c.options.nonceSignature) body.apple_pay.nonce_signature = c.options.nonceSignature
    }
    if (c.options.walletProvider === 'google_pay') {
      body.google_pay = {}
      if (c.options.clientWalletAccountId) body.google_pay.client_wallet_account_id = c.options.clientWalletAccountId
      if (c.options.clientDeviceId) body.google_pay.client_device_id = c.options.clientDeviceId
    }
    return createMobileWalletProvisioningRequest(c.args.customerId, c.args.cardAccountId, body)
  },
})

bridgeCards.command('designs', {
  description: 'List available Bridge card designs',
  async run() { return listCardDesigns() },
})

bridgeCards.command('program-summary', {
  description: 'Get a summary of your Bridge card program',
  options: z.object({
    period: z.enum(['day', 'week', 'month', 'year', 'lifetime']).default('lifetime').describe('Summary period'),
    periodKey: z.string().optional().describe('Period key, such as YYYYMM for month'),
  }),
  async run(c) {
    const params: Record<string, string> = { period: c.options.period }
    if (c.options.periodKey) params.period_key = c.options.periodKey
    return getCardProgramSummary(params)
  },
})

cli.command(bridgeCards)

// --- profile subcommand group ---
const profile = Cli.create('profile', { description: 'Profile transfer webhook latency end-to-end (create transfers, receive webhooks, measure timings, return funds).' })

profile.command('run', {
  description: 'Run the transfer webhook latency profiler',
  outputPolicy: 'agent-only',
  options: z.object({
    onBehalfOf: z.string().optional().describe('Customer ID (defaults to CUSTOMER_ID env var)'),
    sourceRail: z.string().default('bridge_wallet').describe('Source payment rail (bridge_wallet, or tempo for deposit-funded transfers from the local wallet)'),
    sourceCurrency: z.string().default('usdc').describe('Source currency'),
    sourceWalletId: z.string().optional().describe('Source Bridge wallet ID (defaults to BRIDGE_WALLET_ID env var)'),
    destRail: z.string().default('tempo').describe('Destination payment rail'),
    destCurrency: z.string().default('usdc').describe('Destination currency'),
    destAddress: z.string().optional().describe('Destination address (defaults to the address of PROFILE_WALLET_PRIVATE_KEY)'),
    amount: z.string().default('1.00').describe('Transfer amount per run'),
    runs: z.number().default(10).describe('Total number of transfers to profile'),
    batchSize: z.number().default(10).describe('Transfers created concurrently per batch'),
    timeoutSeconds: z.number().default(180).describe('Seconds to wait for payment_processed per transfer'),
    webhookGraceSeconds: z.number().default(60).describe('Seconds to keep waiting for the webhook after the API poll observes completion'),
    returnFundsAtEnd: z.boolean().default(false).describe('Return funds once after all runs instead of per batch'),
    batchReturnSingleTx: z.boolean().default(true).describe('Return each batch as one on-chain transaction'),
    stopOnInsufficientBalance: z.boolean().default(true).describe('Stop early when the Bridge wallet balance is insufficient'),
    postReturnSettleSeconds: z.number().default(0).describe('Seconds to wait after a batch return before the next batch'),
    feeToken: z.string().default('usdc.e').describe('Tempo fee token for return transfers (usdc.e or pathusd)'),
    tokenContract: z.string().default(TEMPO_USDC_E_TOKEN_ADDRESS).describe('Tempo token contract for returns and balance checks'),
    tokenDecimals: z.number().default(6).describe('Token decimals'),
    rpcUrl: z.string().default('https://rpc.tempo.xyz').describe('Tempo RPC URL (deposits, returns, and Tempo tx timestamps)'),
    destRpcUrl: z.string().optional().describe('Destination chain RPC URL for dest tx timestamps (defaults per rail: tempo, polygon, ethereum, base, arbitrum, optimism)'),
    webhookPort: z.number().default(8088).describe('Local webhook receiver port'),
    webhookPath: z.string().default('/webhooks/bridge').describe('Webhook path'),
    publicWebhookUrl: z.string().optional().describe('Public webhook URL (skips starting ngrok)'),
    ngrokDomain: z.string().optional().describe('Reserved ngrok domain'),
    webhookId: z.string().optional().describe('Existing Bridge webhook endpoint ID to delete and recreate'),
    recreateWebhook: z.boolean().default(true).describe('Delete and recreate a matching Bridge webhook endpoint'),
    deleteWebhookOnExit: z.boolean().default(true).describe('Delete the Bridge webhook endpoint on exit'),
    eventCategories: z.string().default('all').describe('Webhook event categories (all, or comma-separated list)'),
    eventEpoch: z.string().default('webhook_creation').describe('Webhook event epoch'),
    selfTest: z.boolean().default(true).describe('POST a self-test event through the public URL before profiling'),
    debugOnTimeout: z.boolean().default(true).describe('Fetch transfer state and receiver stats when a run times out'),
    txTimestampLookup: z.boolean().default(true).describe('Look up on-chain block timestamps for webhook tx hashes'),
    txTimestampRpcRetries: z.number().default(20).describe('RPC retries when resolving a tx timestamp'),
    txTimestampRpcSleepSeconds: z.number().default(0.5).describe('Sleep between tx timestamp RPC retries'),
    outputDir: z.string().default('tempo_webhook_latency_results').describe('Directory for results files'),
    outputPrefix: z.string().optional().describe('Filename prefix for results files'),
    clientReferencePrefix: z.string().default('bridgerton-webhook-profile').describe('Prefix for transfer client_reference_id values'),
    verbose: z.boolean().default(false).describe('Log each webhook event as it arrives'),
  }),
  async run(c) { return runProfile(c.options) },
})

profile.command('return-funds', {
  description: 'Return profiled funds: from the local wallet back to the Bridge wallet on Tempo, or from an EVM chain back to the local wallet on Tempo via a reverse Bridge transfer',
  outputPolicy: 'agent-only',
  options: z.object({
    amount: z.string().optional().describe('Amount to return (defaults to the entire wallet token balance)'),
    fromRail: z.string().default('tempo').describe('Rail holding the funds: tempo (direct send to Bridge wallet) or polygon/ethereum/base/arbitrum/optimism (reverse Bridge transfer to the local wallet on Tempo; needs native gas)'),
    fromRpcUrl: z.string().optional().describe('RPC URL for the EVM from-rail (defaults per rail)'),
    onBehalfOf: z.string().optional().describe('Bridge customer ID for the reverse transfer (defaults to CUSTOMER_ID env var; EVM from-rail only)'),
    timeoutSeconds: z.number().default(600).describe('Seconds to wait for the reverse transfer to process (EVM from-rail only)'),
    sourceWalletId: z.string().optional().describe('Bridge wallet ID to return funds to (defaults to BRIDGE_WALLET_ID env var)'),
    bridgeWalletAddress: z.string().optional().describe('Bridge wallet address (skips the wallet lookup)'),
    feeToken: z.string().default('usdc.e').describe('Tempo fee token (usdc.e or pathusd)'),
    tokenContract: z.string().default(TEMPO_USDC_E_TOKEN_ADDRESS).describe('Tempo token contract to send'),
    tokenDecimals: z.number().default(6).describe('Token decimals'),
    currency: z.string().default('usdc').describe('Currency to return'),
    rpcUrl: z.string().default('https://rpc.tempo.xyz').describe('Tempo RPC URL'),
    outputDir: z.string().default('tempo_webhook_latency_results').describe('Directory for the returns log'),
  }),
  async run(c) { return runReturnFunds(c.options) },
})

profile.command('summarize', {
  description: 'Print the latency summary for a previous run results JSONL file',
  outputPolicy: 'agent-only',
  args: z.object({ resultsFile: z.string().describe('Path to a .results.jsonl file') }),
  async run(c) { return summarizeResults(c.args.resultsFile) },
})

cli.command(profile)

// --- configure subcommand group ---
const configure = Cli.create('configure', { description: 'Manage CLI configuration.' })

configure.command('api-key', {
  description: 'Save your Bridge API key',
  args: z.object({ apiKey: z.string().describe('Bridge API key (sk-live-... or sk-test-...)') }),
  async run(c) {
    writeConfig({ api_key: c.args.apiKey })
    const env = c.args.apiKey.startsWith('sk-test') ? 'sandbox' : 'production'
    return { saved: true, environment: env, config: '~/.config/bridgerton/config.json' }
  },
})

configure.command('stripe-api-key', {
  description: 'Save your Stripe API key',
  args: z.object({ apiKey: z.string().describe('Stripe API key (sk_live_... or sk_test_...)') }),
  async run(c) {
    writeConfig({ stripe_api_key: c.args.apiKey })
    const mode = c.args.apiKey.startsWith('sk_test') ? 'test' : 'live'
    return { saved: true, mode, config: '~/.config/bridgerton/config.json' }
  },
})

configure.command('format', {
  description: 'Set the default output format',
  args: z.object({ format: z.enum(['toon', 'json', 'yaml', 'md', 'jsonl']).describe('Output format') }),
  async run(c) {
    writeConfig({ format: c.args.format })
    return { saved: true, format: c.args.format }
  },
})

configure.command('show', {
  description: 'Show current configuration',
  async run() {
    const bridgeKey = getApiKey()
    const stripeKey = getStripeApiKey()
    const bridgeSource = process.env.BRIDGE_API_KEY ? 'BRIDGE_API_KEY env var' : bridgeKey ? '~/.config/bridgerton/config.json' : null
    const stripeSource = process.env.STRIPE_SECRET_KEY
      ? 'STRIPE_SECRET_KEY env var'
      : process.env.STRIPE_API_KEY
        ? 'STRIPE_API_KEY env var'
        : stripeKey
          ? '~/.config/bridgerton/config.json'
          : null
    return {
      bridge: bridgeKey
        ? {
            api_key: maskSecret(bridgeKey),
            environment: bridgeKey.startsWith('sk-test') ? 'sandbox' : 'production',
            source: bridgeSource,
          }
        : { api_key: null, environment: null, source: null },
      stripe: stripeKey
        ? {
            api_key: maskSecret(stripeKey),
            mode: stripeKey.startsWith('sk_test') ? 'test' : 'live',
            source: stripeSource,
          }
        : { api_key: null, mode: null, source: null },
      format: getDefaultFormat() ?? 'toon',
    }
  },
})

cli.command(configure)

// --- exchange rates ---
cli.command('rates', {
  description: 'Get current exchange rates',
  options: z.object({
    from: z.string().default('usd').describe('Source currency (e.g. usd, eur, brl)'),
    to: z.string().default('usdc').describe('Destination currency (e.g. usdc, usdb, usdt)'),
  }),
  alias: { from: 'f', to: 't' },
  async run(c) { return getExchangeRates(c.options.from, c.options.to) },
})

export default cli
