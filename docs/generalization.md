# Generalizing beyond frontend apps

The orchestration engine is already mostly domain-agnostic:

- the sprint loop in `src/harness.ts`
- durable run state and resume support
- provider abstraction (`claude-sdk`, `codex`)
- researcher-generated evaluation criteria in `plan/eval-criteria.json`
- data-driven pass/fail enforcement in `resolvePass()`

That means the harness is no longer locked to a single hardcoded UI rubric. A researcher can define project-specific criteria for a CLI, API, library, or workflow tool, and the harness will enforce those criteria the same way it enforces the universal ones.

## What is still frontend-skewed

Two things still tilt the defaults toward web apps:

### 1. Browser QA defaults

The default Claude evaluator configuration attaches Playwright MCP. That is great for browser apps, but not every project needs it.

The code now treats browser automation as optional:

- Claude uses browser QA only if the evaluator role actually has Playwright configured.
- Codex uses browser QA only if you explicitly declare that your Codex environment provides it via `codex.assumePlaywrightMcp`.
- Otherwise the evaluator is told to fall back to smoke tests, CLI checks, HTTP checks, and code review.

### 2. Default smoke lifecycle examples

The sample configs still look like app/server workflows because they include `npm run dev` and `npm test`. For non-web projects, those should be replaced with whatever your project needs:

- CLI tool: no dev server, smoke test is command invocation
- API service: dev server plus HTTP checks
- library: no dev server, smoke test is test runner + typecheck
- data pipeline: no dev server, smoke test is fixture execution

## What to change for a new project type

You usually only need to adjust configuration and prompt expectations:

1. Set `smoke.install`, `smoke.start`, `smoke.test`, and `smoke.stop` for the project’s real lifecycle.
2. Give the researcher enough context in the user prompt so it can produce useful project-specific criteria.
3. Configure provider tooling to match reality. Don’t tell the evaluator it has browser tooling unless it really does.
4. Add any project-specific skills under `skills` so they are installed into both Claude and Codex skill directories.

## Good next improvements

If this repo needs to become truly profile-driven, the next useful layer would be explicit project profiles such as `webapp`, `api`, `cli`, and `library`. Those profiles could bundle:

- recommended smoke commands
- preferred evaluator tooling
- default research hints
- optional skill packs

But the important part is already done: pass/fail logic is criteria-driven instead of hardcoded to a visual-web rubric.
