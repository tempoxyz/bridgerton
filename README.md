# bridgerton

CLI and MCP server for [Bridge.xyz](https://www.bridge.xyz) stablecoin infrastructure.

## Install

```bash
npm install -g bridgerton
```

Or run directly:

```bash
npx bridgerton --help
```

## Setup

On first run with no arguments, bridgerton prompts for your API key interactively. Or configure it explicitly:

```bash
bridgerton configure api-key sk-test-...
```

You can also set it via environment variable:

```bash
export BRIDGE_API_KEY=sk-test-...
```

Environment is auto-detected from the key prefix — `sk-test-*` routes to sandbox, `sk-live-*` to production.

Stripe Issuing commands use a Stripe secret key from `STRIPE_SECRET_KEY`, then `STRIPE_API_KEY`, then the saved config:

```bash
bridgerton configure stripe-api-key sk_live_...
```

## Usage

```bash
# check exchange rates
bridgerton rates --from usd --to usdc

# list customers
bridgerton customers list

# create a customer
bridgerton customers create -f John -l Doe -e john@example.com

# create a wallet on tempo
bridgerton wallets create <customer-id> --chain tempo

# create a liquidation address
bridgerton liquidation create <customer-id> \
  --chain tempo --currency usdc \
  --destination-address 0x...

# create a transfer
bridgerton transfers create \
  --on-behalf-of <customer-id> \
  --source-rail bridge_wallet --source-currency usdc \
  --dest-rail tempo --dest-currency usdc \
  --dest-address 0x...

# create a transfer to another Bridge wallet
bridgerton transfers create \
  --on-behalf-of <customer-id> \
  --source-rail bridge_wallet --source-currency usdc \
  --source-wallet-id <source-wallet-id> \
  --dest-rail tempo --dest-currency usdc \
  --dest-wallet-id <destination-wallet-id> \
  --amount 1.50

# set default output format
bridgerton configure format json

# save a Stripe API key for Issuing commands
bridgerton configure stripe-api-key sk_live_...

# see "Tempo Wallet-Backed Cards" below for the full Bridge + Stripe flow
```

## Tempo Wallet-Backed Cards

For Bridge-managed consumer cardholders, Bridge owns onboarding, ToS, KYC, endorsements, and the link to the Stripe Issuing cardholder. Stripe owns new Tempo wallet-backed card issuance after Bridge returns a `stripe_cardholder_id`.

Start with Bridge and wait for the customer to complete hosted ToS and KYC:

```bash
bridgerton customers create -f John -l Doe -e john@example.com

bridgerton customers tos-acceptance-link <customer-id>
bridgerton customers kyc-link <customer-id> --endorsement cards

bridgerton customers get <customer-id>
```

Send the hosted ToS and KYC links to the customer, then poll `customers get` until ToS/KYC are approved, the `cards` endorsement is approved, and the customer includes a `stripe_cardholder_id`.

Then create the Tempo wallet-backed Stripe card:

```bash
bridgerton cards create \
  --cardholder <stripe-cardholder-id> \
  --wallet-address <tempo-wallet-address> \
  --idempotency-key tempo-cards-<bridge-customer-id> \
  --bridge-customer-id <bridge-customer-id>
```

Bridge's deprecated Cards API operation is card account provisioning (`POST /customers/{customerID}/card_accounts`). New stablecoin card issuance and management for Tempo wallet-backed cards lives under `bridgerton cards`. Existing Bridge card-account utility endpoints such as list, get, update, freeze, unfreeze, transactions, authorizations, withdrawals, PIN update URL, ephemeral keys, card-account statements, card designs, and program summary remain available under `bridgerton bridge-cards`.

For non-custodial Tempo wallets, approve Bridge's issuer contract before testing live spend:

```bash
tempo wallet whoami --json-output

export TEMPO_ROOT_ACCOUNT=0x...
export USDC_E=0x20c000000000000000000000b9537d11c60e8b50
export ISSUER=0x3e8f24b686aa8c036038f7d557b70e6ce0e7b56b

cast erc20-token approve "$USDC_E" "$ISSUER" <allowance-base-units> \
  --rpc-url https://rpc.tempo.xyz \
  --chain 4217 \
  --from "$TEMPO_ROOT_ACCOUNT" \
  --browser

cast call "$USDC_E" "allowance(address,address)(uint256)" "$TEMPO_ROOT_ACCOUNT" "$ISSUER" \
  --rpc-url https://rpc.tempo.xyz
```

Use the Tempo wallet signer for approval. Do not store Tempo access keys in Bridgerton config.

Card statements include sensitive financial data and must be written to a file:

```bash
bridgerton cards statements create \
  --cardholder <stripe-cardholder-id> \
  --card <stripe-card-id> \
  --period 202605 \
  --output statement-202605.pdf
```

Card issuance smoke test checklist:

1. Retrieve the cardholder with `bridgerton cards cardholders get <stripe-cardholder-id>`.
2. Create the card with a stable `--idempotency-key`, then rerun the same command and confirm the same card is returned.
3. Retrieve the card with `bridgerton cards get <card-id>` and confirm `type=virtual`, `status=active`, `currency=usd`, and the Tempo wallet metadata.
4. Run a small live authorization, then check Stripe Issuing activity and the wallet allowance/balance on Tempo.

## Commands

| Group | Commands |
|---|---|
| `customers` | `create`, `get`, `list`, `update`, `delete`, `tos-link`, `kyc-link`, `tos-acceptance-link`, `transfers` |
| `wallets` | `create`, `get`, `list`, `list-all`, `total-balances`, `history` |
| `transfers` | `create`, `get`, `list` |
| `liquidation` | `create`, `get`, `list`, `update`, `drains`, `all-drains` |
| `external-accounts` | `create`, `get`, `list`, `delete` |
| `virtual-accounts` | `create`, `get`, `list`, `list-all`, `update`, `deactivate`, `reactivate`, `activity`, `all-activity` |
| `prefunded-accounts` | `list`, `get`, `history` |
| `cards` | `create`, `list`, `get`, `update`, `freeze`, `unfreeze`, `cancel`, `cardholders list`, `cardholders get`, `transactions list`, `transactions get`, `authorizations list`, `authorizations get`, `statements create` |
| `bridge-cards` | `list`, `get`, `update`, `freeze`, `unfreeze`, `pin-update-url`, `ephemeral-key`, `statement`, `transactions`, `transaction`, `authorizations`, `authorization-controls`, `withdraw`, `withdrawals`, `get-withdrawal`, `add-deposit-address`, `mobile-provision`, `designs`, `program-summary` |
| `configure` | `api-key`, `stripe-api-key`, `format`, `show` |
| `rates` | Get current exchange rates |

All commands support `--format toon|json|yaml|md|jsonl` and `--help`.

## Agent Setup

Give your AI agent (Claude Code, Amp, Cursor, Copilot, etc.) full access to Bridge.xyz:

```bash
npx bridgerton mcp add      # register as MCP server — gives agents direct tool access
npx bridgerton skills add   # install skill files — gives agents context on available commands
```

That's it. Your agent can now run commands like "create a wallet on tempo for a customer" or "list all transfers".

You can also run the MCP server directly in stdio mode:

```bash
bridgerton --mcp
```

## Development

```bash
bun install
bun run build        # tsc + chmod
bun run typecheck    # tsc --noEmit
```

## Built with

[incur](https://github.com/wevm/incur) — one CLI router that gives you a CLI, MCP server, and agent skills for free.

## License

MIT
