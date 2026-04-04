# Repository Guidelines

## Project Structure & Module Organization
`src/` contains all source code. Start with `src/cli.ts` for command parsing and `src/harness.ts` for the sprint/state-machine flow. Provider adapters live in `src/providers/` (`claude-sdk`, `codex`); shared config, prompts, types, and helpers live in `src/config.ts`, `src/prompts.ts`, `src/types.ts`, and `src/utils.ts`. `examples/harness.config.json` is the reference config, `docs/` holds design notes, and `dist/` is generated build output. Do not edit `dist/` by hand.

## Build, Test, and Development Commands
- `npm install`: install dependencies; Node.js `>=20` is required.
- `npm run build`: compile `src/` into `dist/` and emit declaration files.
- `npm run typecheck`: run strict TypeScript checks without writing build output.
- `npm run harness -- init`: create a starter `harness.config.json`.
- `npm run harness -- run "Build a ..."`: execute the harness against `claude-sdk` or `codex`.

## Coding Style & Naming Conventions
Use TypeScript ESM with `node:` imports, single quotes, semicolons, and 2-space indentation. Keep filenames lowercase with hyphens, for example `dev-server.ts` and `codex-client.ts`. Use `PascalCase` for exported types and classes, `camelCase` for functions, variables, and config keys. Preserve the current Node16 import pattern: local TypeScript imports should end in `.js`.

## Testing Guidelines
There is no dedicated automated test suite yet. Minimum validation for most changes is `npm run build` and `npm run typecheck`. For provider changes, also capture a reproducible `harness run ... --provider claude-sdk|codex` command in the PR notes. If you add tests later, place them beside the module under test or under a new `test/` directory and use `*.test.ts` names.

## Commit & Pull Request Guidelines
Git history is not available in this checkout, so no repository-specific convention can be inferred. Use short, imperative commit subjects such as `Tighten codex resume error handling` and keep each commit focused. Pull requests should summarize behavior changes, list verification commands, note config updates, and attach relevant logs or sample `.harness/runs/<run-id>/` artifacts when diagnosing harness behavior.

## Security & Configuration Tips
Do not commit `.harness/`, `tmp/`, `node_modules/`, or secrets. Keep Claude credentials in environment variables and let Codex use its local ChatGPT login state instead of tracked JSON config.
