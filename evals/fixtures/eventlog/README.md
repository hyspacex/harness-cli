# Ledger

A small event-sourced inventory ledger. State is never stored directly — it is
derived by replaying an append-only JSONL event log (`LEDGER_FILE`, default
`ledger.jsonl`). The log is the source of truth and must never be rewritten,
reordered, or truncated.

## CLI

```
node bin/ledger.mjs add <name> <qty>      # add a new item
node bin/ledger.mjs adjust <name> <delta> # change an item's quantity
node bin/ledger.mjs remove <name>         # remove an item
node bin/ledger.mjs state                 # print current state as JSON
node bin/ledger.mjs history               # print the event log
```

Errors print to stderr and exit non-zero.

## Layout

- `src/events.mjs` — event log read/append
- `src/state.mjs` — replay and reducer
- `bin/ledger.mjs` — CLI
- `golden-v1.jsonl` — a real production ledger file kept for compatibility testing
- `expected-state-v1.json` — the state that ledger should produce

Run tests with `npm test`.
