# Agent instructions

This directory is a consumer project under architecture control. It is the checked-in demonstration of the guidance `fitc4` recommends for any repository agents work in.

## Architecture gate (fitc4)

- Run `npm run fitc4 -w example` before handing off changes; it checks the code against the LikeC4 architecture model in `arch/model.c4`. Exit 1 is an architecture violation, not a flaky tool.
- A finding means the code and the contract disagree. Fixing the code is the default. Editing the model is a design decision. It is legitimate when the architecture genuinely changed, never merely to silence a finding. Call out any model change explicitly when handing off.
- Never delete `sources` metadata or a declared relationship to make a finding go away. That removes code from architecture control entirely.
- Rule reference: `node_modules/fitc4/README.md#rules` (in this workspace, `packages/fitc4/README.md#rules`). Structured output: `npx fitc4 --json`.

## This example in particular

- `README.md` here walks two deliberate failure exercises (`src/core/bad.ts`, `src/util.ts`). Those files are teaching props. Never commit them.
- `fitc4.agent.config.ts` shells out to a locally installed `claude` CLI on the user's own billing. Do not run `npm run fitc4:agent` unless asked.
