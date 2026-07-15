# bridgerton

## 0.7.0

### Minor Changes

- [#10](https://github.com/tempoxyz/bridgerton/pull/10) [`1bbd04c`](https://github.com/tempoxyz/bridgerton/commit/1bbd04c205da8e9fbdfd2b2ffb2929f338f602a2) Thanks [@gorried](https://github.com/gorried)! - Add a destination Bridge wallet option to transfer creation.

- [#13](https://github.com/tempoxyz/bridgerton/pull/13) [`b54ca61`](https://github.com/tempoxyz/bridgerton/commit/b54ca61b237a63ad6ad572690f1c19512da21a87) Thanks [@Slokh](https://github.com/Slokh)! - Add `profile` commands for end-to-end transfer latency profiling: `profile run` creates transfers over a configurable route (e.g. `bridge_wallet → tempo`, `tempo → polygon`), funds crypto-source deposits from the local wallet, receives Bridge webhooks through an in-process ngrok tunnel (with an API-poll fallback for missed events), measures request→payment_processed lifecycle latency, and returns funds — for EVM destinations via measured reverse transfers so both directions get latency data. `profile return-funds` sweeps funds back standalone; `profile summarize` re-prints the latency summary for a previous run.

- [#14](https://github.com/tempoxyz/bridgerton/pull/14) [`a6d219a`](https://github.com/tempoxyz/bridgerton/commit/a6d219a77e7f2efc0b9b9d4b250f9e8eec51ccec) Thanks [@Slokh](https://github.com/Slokh)! - Add Solana USDC and USDT as source currencies for transfer profiling.

- [#14](https://github.com/tempoxyz/bridgerton/pull/14) [`a6d219a`](https://github.com/tempoxyz/bridgerton/commit/a6d219a77e7f2efc0b9b9d4b250f9e8eec51ccec) Thanks [@Slokh](https://github.com/Slokh)! - Support direct USDC fund returns for Bridge-wallet to EVM profiling routes when the destination is the local wallet.

- [#12](https://github.com/tempoxyz/bridgerton/pull/12) [`8de150b`](https://github.com/tempoxyz/bridgerton/commit/8de150b138c0b472b950996cd820cfef41eb9b0c) Thanks [@gorried](https://github.com/gorried)! - Add static transfer template management commands and transfer creation options for reusable Bridge payment routes.

### Patch Changes

- [#14](https://github.com/tempoxyz/bridgerton/pull/14) [`a6d219a`](https://github.com/tempoxyz/bridgerton/commit/a6d219a77e7f2efc0b9b9d4b250f9e8eec51ccec) Thanks [@Slokh](https://github.com/Slokh)! - Fix the native Optimism USDC contract address used by profile reverse transfers.

- [#14](https://github.com/tempoxyz/bridgerton/pull/14) [`a6d219a`](https://github.com/tempoxyz/bridgerton/commit/a6d219a77e7f2efc0b9b9d4b250f9e8eec51ccec) Thanks [@Slokh](https://github.com/Slokh)! - Profile runs now wait for the Bridge wallet balance to recover after per-batch fund returns before starting the next batch, avoiding "amount exceeds available balance" failures.

- [#14](https://github.com/tempoxyz/bridgerton/pull/14) [`a6d219a`](https://github.com/tempoxyz/bridgerton/commit/a6d219a77e7f2efc0b9b9d4b250f9e8eec51ccec) Thanks [@Slokh](https://github.com/Slokh)! - profile run now prefers webhook delivery for completion latency; API polling acts only as a fallback after a configurable --webhook-grace-seconds window

## 0.6.0

### Minor Changes

- [#7](https://github.com/struong/bridgerton/pull/7) [`559205b`](https://github.com/struong/bridgerton/commit/559205b069d2eca56b6fdcd3cbf8635eb05fd855) Thanks [@letstokenize](https://github.com/letstokenize)! - Make `bridgerton cards` the Stripe Issuing command surface for Tempo wallet-backed cards, move active Bridge card-account utilities to `bridge-cards`, add Stripe API key configuration with private file permissions, and document the Bridge ToS/KYC handoff plus Tempo issuer approval flow. Card statements now require an output file instead of printing PDF content to stdout.

## 0.5.0

### Minor Changes

- [#5](https://github.com/struong/bridgerton/pull/5) [`eaa2836`](https://github.com/struong/bridgerton/commit/eaa2836301bcfe6d0a0ef2a987660f2db5786ce6) Thanks [@struong](https://github.com/struong)! - Add `cards` command group for Bridge card issuance, management, transactions, and mobile wallet provisioning.

## 0.4.0

### Minor Changes

- [#3](https://github.com/struong/bridgerton/pull/3) [`8feeb8d`](https://github.com/struong/bridgerton/commit/8feeb8d75f74e84c261b767851fdca074a3a3b44) Thanks [@letstokenize](https://github.com/letstokenize)! - `external-accounts create` now defaults to Plaid Link — run it with just a customer ID to open a browser-based bank linking flow. Pass `--accountNumber`, `--routingNumber`, and `--accountOwnerName` to create manually instead.

## 0.3.1

### Patch Changes

- [`3d215ac`](https://github.com/struong/bridgerton/commit/3d215ac8909a28c660ab5f84ca4cd640d3eef26b) Thanks [@struong](https://github.com/struong)! - Credit incur in --help output and README.

## 0.3.0

### Minor Changes

- [`31efa71`](https://github.com/struong/bridgerton/commit/31efa71eae8504e9262c3c7c46a5bc4de9eedfef) Thanks [@struong](https://github.com/struong)! - Add `configure` subcommand group for persistent CLI settings:

  - `configure api-key` — save API key to `~/.config/bridgerton/config.json`
  - `configure format` — set default output format (toon, json, yaml, md, jsonl)
  - `configure show` — display current config with masked key and source

- [`31efa71`](https://github.com/struong/bridgerton/commit/31efa71eae8504e9262c3c7c46a5bc4de9eedfef) Thanks [@struong](https://github.com/struong)! - Interactive onboarding on first run — prompts for API key when none is configured and no arguments are passed.

### Patch Changes

- [`f7a7442`](https://github.com/struong/bridgerton/commit/f7a744258cdb8c59233600a590eb1469f781ceae) Thanks [@struong](https://github.com/struong)! - Remove dead code from client.ts (unused `promptForKey`/`ensureApiKey`), replace sloppy `as any` cast with proper Format type, and use Node shebang for cross-runtime support.

## 0.2.0

### Minor Changes

- Add API parity for customers, wallets, liquidation, virtual accounts, and prefunded accounts.

  **New domains:**

  - `prefunded-accounts` — list, get, history

  **New commands:**

  - `customers update`, `delete`, `tos-link`, `kyc-link`, `tos-acceptance-link`, `transfers`
  - `wallets list-all`, `total-balances`, `history`
  - `liquidation update`, `all-drains`
  - `virtual-accounts list-all`, `update`, `deactivate`, `reactivate`, `activity`, `all-activity`
  - `external-accounts` — create, get, list, delete
