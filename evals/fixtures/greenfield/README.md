# Greenfield Benchmark Fixture

A deliberately minimal Node.js (>= 20, ESM) workspace used by the `bench-*` eval
cases. It ships with one passing baseline test so `npm test` is green before any
agent work starts; benchmark runs must keep it green.

No dependencies are installed on purpose: benchmark prompts restrict solutions
to Node.js built-ins so runs across providers and ceremony levels stay
comparable and cheap to verify.
