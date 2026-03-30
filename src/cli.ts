import { Cli, z } from 'incur'
import { createCustomer, getCustomer, listCustomers, updateCustomer, deleteCustomer, createTosLink, getKycLink, getTosAcceptanceLink, listCustomerTransfers } from './core/customers.js'
import { createWallet, getWallet, listWallets, listAllWallets, getWalletTotalBalances, getWalletHistory } from './core/wallets.js'
import { createTransfer, getTransfer, listTransfers } from './core/transfers.js'
import { createLiquidation, getLiquidation, listLiquidations, listDrains, updateLiquidation, listAllDrains } from './core/liquidation.js'
import { createExternalAccount, getExternalAccount, listExternalAccounts, deleteExternalAccount } from './core/external-accounts.js'
import { createVirtualAccount, getVirtualAccount, listVirtualAccounts, listAllVirtualAccounts, updateVirtualAccount, deactivateVirtualAccount, reactivateVirtualAccount, getVirtualAccountActivity, getAllVirtualAccountActivity } from './core/virtual-accounts.js'
import { getExchangeRates } from './core/exchange-rates.js'
import { runPlaidLinkFlow } from './core/plaid-link.js'
import { listPrefundedAccounts, getPrefundedAccount, getPrefundedAccountHistory } from './core/prefunded-accounts.js'
import { writeConfig, getApiKey, getDefaultFormat } from './core/client.js'
import pkg from '../package.json' with { type: 'json' }

const cli = Cli.create('bridgerton', {
  version: pkg.version,
  description: 'Bridge.xyz stablecoin infrastructure CLI. Built with incur.',
  format: getDefaultFormat() as 'toon' | 'json' | 'yaml' | 'md' | 'jsonl' | undefined,
  sync: {
    suggestions: [
      'create a wallet on tempo for a customer',
      'list all transfers',
      'create a liquidation address on tempo',
      'check exchange rates',
    ],
  },
})

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
    amount: z.string().optional().describe('Transfer amount'),
    flexibleAmount: z.boolean().default(false).describe('Allow any deposit amount'),
    sourceWalletId: z.string().optional().describe('Source Bridge wallet ID (when source rail is bridge_wallet)'),
    externalAccountId: z.string().optional().describe('External account ID (for off-ramps)'),
  }),
  async run(c) {
    const { onBehalfOf, sourceRail, sourceCurrency, destRail, destCurrency, destAddress, amount, flexibleAmount, sourceWalletId, externalAccountId } = c.options
    const body: any = {
      on_behalf_of: onBehalfOf,
      source: { payment_rail: sourceRail, currency: sourceCurrency },
      destination: { payment_rail: destRail, currency: destCurrency },
    }
    if (destAddress) body.destination.to_address = destAddress
    if (amount) body.amount = amount
    if (flexibleAmount) body.features = { flexible_amount: true }
    if (sourceWalletId) body.source.bridge_wallet_id = sourceWalletId
    if (externalAccountId) body.source.external_account_id = externalAccountId
    return createTransfer(body)
  },
})

transfers.command('get', {
  description: 'Get a transfer by ID',
  args: z.object({ id: z.string().describe('Transfer ID') }),
  async run(c) { return getTransfer(c.args.id) },
})

transfers.command('list', {
  description: 'List all transfers',
  async run() { return listTransfers() },
})

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
    const key = getApiKey()
    if (!key) return { error: 'No API key configured. Run: bridgerton configure api-key <key>' }
    const source = process.env.BRIDGE_API_KEY ? 'BRIDGE_API_KEY env var' : '~/.config/bridgerton/config.json'
    const env = key.startsWith('sk-test') ? 'sandbox' : 'production'
    return { api_key: key.slice(0, 12) + '...' + key.slice(-4), environment: env, format: getDefaultFormat() ?? 'toon', source }
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
