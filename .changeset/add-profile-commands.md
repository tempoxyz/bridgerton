---
"bridgerton": minor
---

Add `profile` commands for end-to-end transfer latency profiling: `profile run` creates transfers over a configurable route (e.g. `bridge_wallet → tempo`, `tempo → polygon`), funds crypto-source deposits from the local wallet, receives Bridge webhooks through an in-process ngrok tunnel (with an API-poll fallback for missed events), measures request→payment_processed lifecycle latency, and returns funds — for EVM destinations via measured reverse transfers so both directions get latency data. `profile return-funds` sweeps funds back standalone; `profile summarize` re-prints the latency summary for a previous run.
