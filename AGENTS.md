# bridgerton

Bridge.xyz stablecoin infrastructure CLI. Built with incur.

## Architecture

One incur router CLI (`cli.ts`) with subcommand groups for each Bridge API domain. `cli.fetch` provides HTTP API + MCP for free.

```
src/
├── cli.ts              # incur router CLI — all commands
├── bin.ts              # Entry point — cli.serve()
├── index.ts            # Library exports
└── core/
    ├── client.ts       # Bridge API fetch wrapper (auth, base URL)
    ├── customers.ts    # Customers API
    ├── wallets.ts      # Wallets API
    ├── transfers.ts    # Transfers API
    ├── liquidation.ts  # Liquidation addresses API
    ├── external-accounts.ts  # External bank accounts API
    ├── plaid-link.ts   # Plaid Link flow (link_token, local server, public_token exchange)
    ├── virtual-accounts.ts  # Virtual accounts API
    ├── prefunded-accounts.ts # Prefunded accounts API
    └── exchange-rates.ts    # Exchange rates API
```

## Key Design Decisions

- **incur subcommand groups**: `customers`, `wallets`, `transfers`, `liquidation`, `external-accounts`, `virtual-accounts`, `prefunded-accounts`, `configure` as sub-CLIs
- **core/client.ts**: thin fetch wrapper, reads API key from `~/.config/bridgerton/config.json` or `BRIDGE_API_KEY` env var
- **Auto-detect**: `sk-test-*` → sandbox (`https://api.sandbox.bridge.xyz/v0`), `sk-live-*` → production (`https://api.bridge.xyz/v0`)
- **Plaid Link**: `external-accounts create` defaults to Plaid Link (browser-based bank linking). Pass `--accountNumber`, `--routingNumber`, `--accountOwnerName` for manual creation
- **npm package**: published as `bridgerton`

## Development

```bash
bun install
bun run build        # tsc + chmod + bun link
bun run typecheck    # tsc --noEmit
```

## Environment

- `BRIDGE_API_KEY` — Bridge API key (required, auto-detects sandbox vs production from key prefix)

## Changesets

This project uses [changesets](https://github.com/changesets/changesets) for versioning. **Every user-facing change (feat, fix, refactor) MUST include a changeset.**

Since `changeset add` is interactive (TUI), create changeset files manually:

```bash
# File: .changeset/<descriptive-name>.md
---
"bridgerton": patch   # or minor, major
---

Description of the change.
```

- One changeset per logical change (don't bundle unrelated changes)
- `patch` for fixes/refactors, `minor` for new features, `major` for breaking changes
- To release: `bunx changeset version && bun run build && bunx changeset publish`

## Commit Rules

- Atomic commits, conventional messages (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`)
- Always push after committing
