# Repository Guidelines

## Project Structure & Module Organization
The repo is split into two layers with a one-way dependency — `src/core/` (the product harness) and `src/lab/` (the model/provider characterization instrument). Lab imports core; core must never import lab (`test/boundary.test.mjs` enforces this). `src/cli.ts` and `src/cli-flags.ts` sit at the root as the thin CLI layer over both.

Start with `src/cli.ts` for command parsing and `src/core/harness.ts` for the sprint/state-machine flow. Provider adapters live in `src/core/providers/` (`claude-sdk`, `codex`, `pi`); shared config, prompts, types, and helpers live in `src/core/config.ts`, `src/core/prompts.ts`, `src/core/types.ts`, and `src/core/utils.ts`. Lab modules (`cases`, `packet`, `judge`, `objective-checks`, `matrix/`) read completed runs only through `src/core/artifacts/`.

Lab assets live under `lab/` (`cases/`, `fixtures/`, `suites/`, `results/`); product-facing example cases stay in `evals/cases/`. `examples/harness.config.json` is the reference config, `docs/` holds design notes, and `dist/` is generated build output. Do not edit `dist/` by hand. See `ARCHITECTURE.md` for the layer boundary and split triggers.

## Build, Test, and Development Commands
- `npm install`: install dependencies; Node.js `>=20` is required.
- `npm run build:harness`: compile the harness TypeScript (`src/`) into `dist/`.
- `npm run build`: build the example app workspace (vite).
- `node --test test/*.test.mjs`: run the test suite.
- `npm run harness -- init`: create a starter `harness.config.json`.
- `npm run harness -- run "Build a ..." [--runtime-mode full|flat|minimal]`: execute the harness against `claude-sdk`, `codex`, or `pi`.
- `npm run harness -- lab <list|packet|compare|matrix>`: the eval workbench (the old `harness eval <...>` forms are deprecated aliases; `harness eval roi` stays product-side).

## Coding Style & Naming Conventions
Use TypeScript ESM with `node:` imports, single quotes, semicolons, and 2-space indentation. Keep filenames lowercase with hyphens, for example `dev-server.ts` and `codex-client.ts`. Use `PascalCase` for exported types and classes, `camelCase` for functions, variables, and config keys. Preserve the current Node16 import pattern: local TypeScript imports should end in `.js`.

## Testing Guidelines
Tests live under `test/` as `*.test.mjs` files and run with `node --test test/*.test.mjs`. Run them after touching verdict/repair logic, the ceremony ladder, state transitions, or provider behavior. `test/boundary.test.mjs` (core never imports lab) and `test/artifact-boundary.test.mjs` (lab reads runs via `src/core/artifacts/` only) must stay green. For provider changes, also capture a reproducible `harness run ... --provider claude-sdk|codex|pi` command in the PR notes.

## Commit & Pull Request Guidelines
Use short, imperative commit subjects such as `Tighten codex resume error handling` and keep each commit focused. Pull requests should summarize behavior changes, list verification commands, note config updates, and attach relevant logs or sample run artifacts (`<runRoot>/runs/<run-id>/`) when diagnosing harness behavior.

## Security & Configuration Tips
Do not commit `.harness/`, `tmp/`, `node_modules/`, or secrets. Keep Claude credentials in environment variables and let Codex use its local ChatGPT login state instead of tracked JSON config. Never make verification gates (verdicts, frozen evidence, smoke checks, final regression) conditional on ceremony level.
