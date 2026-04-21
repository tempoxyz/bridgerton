# bridgerton

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
