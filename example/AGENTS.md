# Agent instructions

This directory is a consumer project under architecture control — the checked-in demonstration of the guidance `fitc4` recommends for any repository agents work in.

## Architecture gate (fitc4)

- Run `npm run fitc4 -w example` before handing off changes; it checks the code against the LikeC4 architecture model in `arch/model.c4`. Exit 1 is an architecture violation, not a flaky tool.
- A finding means the code and the contract disagree. Fixing the code is the default. Editing the model is a design decision — legitimate when the architecture genuinely changed, never merely to silence a finding — and any model change must be called out explicitly when handing off.
- Never delete `sources` metadata or a declared relationship to make a finding go away: that removes code from architecture control entirely.
- Rule reference: `node_modules/fitc4/README.md#rules` (in this workspace, `packages/fitc4/README.md#rules`). Structured output: `npx fitc4 --json`.

## This example in particular

- `README.md` here walks three deliberate exercises whose teaching props (`src/core/bad.ts`, `src/util.ts`) must not be committed.
- `fitc4.agent.config.ts` shells out to a locally installed `claude` CLI on the user's own billing. Do not run `npm run fitc4:agent` unless asked.
