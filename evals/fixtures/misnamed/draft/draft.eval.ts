/**
 * misnamed/draft: a describe eval with an oracle that can fail.
 *
 * What this fixture exists to catch: a describe pass that answers from the
 * element's NAME instead of its code. That failure was measured for real
 * before excerpt anchoring landed, when a model wrote "The auth component is
 * a Docker Compose service in the Supabase stack" from the name alone, and no
 * eval could see it, because `draft-descriptions` only asked whether the TODO
 * placeholder was gone. An eval that cannot fail is worthless, so this project
 * is built so a name-derived description is measurably WRONG:
 *
 * - `src/cache/` holds no cache. It is the authorization check every other
 *   component clears before acting, and it denies requests.
 * - `src/utils/` holds no utilities. It settles payments and posts ledger
 *   entries, which is where money moves.
 * - `src/legacy/` is not dead code. It is the only live entry point, the
 *   process `main` and the request router.
 *
 * The traps are fair: the code is short and says plainly what it does, so a
 * careful reader gets all three right every time. `expectations.json` gives
 * each element `describeMust` and `describeMustNot` substrings, so a
 * description naming the real responsibility scores a hit and one echoing the
 * directory name scores a miss (see `harness/draft.ts`).
 *
 * Cheap by construction: the structure comes from the deterministic
 * TypeScript scanner, so there is no scan reply to record and the ONLY agent
 * calls in the whole fixture are the three describe calls. Stub mode replays
 * the descriptions a careful reader would write and is perfect as always.
 * Unlike the other draft rows, live mode here is expected to be ABLE to fail,
 * and a live miss is the measurement working, not the fixture rotting.
 *
 * The draft is written to a temp directory rather than into the repository:
 * `draft()` never overwrites, and a checked-in drafted model would make the
 * second run a refusal.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ResolvedConfig } from 'fitc4'
import type { AgentExec } from 'fitc4/agent'

/**
 * Opt into the describe pass: the harness builds a draft describer from this
 * fixture's exec, one call per drafted element. The recorded replies in
 * replies.json match on the `sources` claim each prompt names.
 */
export const describe = true

export default function misnamedDraft(_exec: AgentExec, root: string): ResolvedConfig {
  const project = path.dirname(root)
  return {
    repositoryRoot: project,
    // Fresh and empty, and outside the repository: draft's never-overwrite
    // rule has nothing to trip on and nothing is written into the fixture.
    modelDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fitc4-misnamed-draft-')),
    scanRoots: ['src'],
    tsconfigPath: path.join(project, 'tsconfig.json'),
    // No providers: `pipelineConfig` composes the default typescript-imports
    // scanner, which is the whole structural half of this fixture. The exec
    // parameter is unused here; the harness passes it to the describer.
  }
}
