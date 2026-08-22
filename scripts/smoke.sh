#!/usr/bin/env bash
#
# Install the packed tarball into a throwaway project and run it there.
#
# The workspace cannot catch packaging mistakes: `example` reaches fitc4
# through a symlink, which ignores the `files` allowlist and parts of the
# `exports` map. This script exercises the path a real consumer takes —
# npm pack, npm install, npx fitc4 — and asserts the gate works in both
# directions.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "== pack"
tarball="$work/$(cd "$root/packages/fitc4" && npm pack --pack-destination "$work" --silent)"

echo "== install into a fresh consumer"
consumer="$work/consumer"
mkdir -p "$consumer"
cp -R "$root/example/src" "$root/example/arch" "$consumer/"
cp "$root/example/tsconfig.json" "$consumer/"
sed 's|"../packages/fitc4/schema/|"./node_modules/fitc4/schema/|' \
  "$root/example/fitc4.config.json" > "$consumer/fitc4.config.json"
(cd "$consumer" && npm init -y >/dev/null && npm install --no-audit --no-fund "$tarball" >/dev/null)

echo "== schema resolves through the exports map"
(cd "$consumer" && node -e "
  const assert = require('node:assert')
  const schema = require('fitc4/schema/fitc4.config.schema.json')
  assert.equal(schema.properties.version.const, 1)
")

echo "== library entry point loads"
(cd "$consumer" && node --input-type=module -e "
  import { runPipeline, pipelineConfig, loadConfig, findConfig, exitCodeFor } from 'fitc4'
  const result = await runPipeline(pipelineConfig(loadConfig(findConfig(process.cwd()))))
  if (exitCodeFor(result) !== 0) { console.error(result.findings); process.exit(1) }
")

echo "== fitc4/agent entry point loads"
(cd "$consumer" && node --input-type=module -e "
  import { claudeCli, codexCli, cached, agentOwnershipAdvisor, agentSemanticReview } from 'fitc4/agent'
  const provider = agentOwnershipAdvisor({ exec: claudeCli() })
  if (provider.id !== 'agent-ownership-advisor' || typeof provider.run !== 'function') process.exit(1)
")

echo "== clean project passes"
(cd "$consumer" && npx fitc4)

echo "== --json emits parseable JSON"
(cd "$consumer" && npx fitc4 --json > "$work/result.json")
node -e "
  const assert = require('node:assert')
  const result = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))
  assert.ok(Array.isArray(result.findings), '--json output has no findings array')
  assert.deepEqual(result.modelErrors, [])
" "$work/result.json"

echo "== violation fails and names the rule"
printf "import { status } from '../interface/index.ts'\nexport const bad = status\n" \
  > "$consumer/src/core/bad.ts"
if violation_out="$(cd "$consumer" && npx fitc4 2>&1)"; then
  echo "FAIL: expected a non-zero exit for an undeclared dependency" >&2
  exit 1
fi
# Any non-zero exit could be a crash; the gate only worked if the report names
# the rule this violation actually breaks.
case "$violation_out" in
  *"relationship-direction"*) ;;
  *) echo "FAIL: violation report did not name relationship-direction: $violation_out" >&2; exit 1 ;;
esac
rm "$consumer/src/core/bad.ts"

echo "== init scaffolds a green first run"
fresh="$work/fresh"
mkdir -p "$fresh/src"
printf 'export const started = true\n' > "$fresh/src/index.ts"
printf '{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" } }\n' \
  > "$fresh/tsconfig.json"
(cd "$fresh" && npm init -y >/dev/null && npm install --no-audit --no-fund "$tarball" >/dev/null)
(cd "$fresh" && npx fitc4 init && npx fitc4)

echo "== init refuses to overwrite, without a stack trace"
if init_err="$(cd "$fresh" && npx fitc4 init 2>&1)"; then
  echo "FAIL: expected a non-zero exit from a second init" >&2
  exit 1
fi
case "$init_err" in
  *"already configured"*) ;;
  *) echo "FAIL: second init did not explain itself: $init_err" >&2; exit 1 ;;
esac
case "$init_err" in
  *"    at "*) echo "FAIL: config error printed a stack trace" >&2; exit 1 ;;
esac

echo "== draft replaces init's untouched placeholder"
# The onboarding path a user actually walks: init, then the draft init
# recommends. It used to refuse, because init had written the model file.
draft_out="$(cd "$fresh" && npx fitc4 draft 2>&1)"
case "$draft_out" in
  *"created arch/model.c4"*) ;;
  *) echo "FAIL: draft did not replace init's placeholder: $draft_out" >&2; exit 1 ;;
esac
case "$(cat "$fresh/arch/model.c4")" in
  *"fitc4 init placeholder"*)
    echo "FAIL: the drafted model carries the placeholder marker" >&2; exit 1 ;;
esac

echo "== draft refuses to overwrite the model it just drafted"
# No marker in a drafted model, so the draft is authored territory now, and
# stdout stays a clean model while the reason goes to stderr.
refusal="$(cd "$fresh" && npx fitc4 draft 2>&1 >/dev/null)"
case "$refusal" in
  *"never overwrites"*) ;;
  *) echo "FAIL: draft over its own output did not refuse: $refusal" >&2; exit 1 ;;
esac
printed="$(cd "$fresh" && npx fitc4 draft 2>/dev/null)"
case "$printed" in
  *"note:"*) echo "FAIL: the refused draft printed a note into stdout" >&2; exit 1 ;;
esac
case "$printed" in
  *"specification {"*) ;;
  *) echo "FAIL: the refused draft printed no model to stdout: $printed" >&2; exit 1 ;;
esac

echo "== draft writes a drift-tagged model that gates green"
rm "$fresh/arch/model.c4"
mkdir -p "$fresh/src/api"
printf "import { started } from '../index.js'\nexport const api = started\n" \
  > "$fresh/src/api/server.ts"
(cd "$fresh" && npx fitc4 draft)
case "$(cat "$fresh/arch/model.c4")" in
  *"#drift"*) ;;
  *) echo "FAIL: the drafted model carries no drift tag" >&2; exit 1 ;;
esac
draft_run="$(cd "$fresh" && npx fitc4)"
case "$draft_run" in
  *"drift: 1 declared, 1 exercised, 0 unused"*) ;;
  *) echo "FAIL: the drafted model did not gate as counted drift: $draft_run" >&2; exit 1 ;;
esac

echo "== --version matches the manifest"
version="$(cd "$consumer" && npx fitc4 --version)"
# Path passed as an argument, not embedded in the expression: Git Bash on
# Windows converts POSIX paths in bare arguments but not inside strings.
expected="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$root/packages/fitc4/package.json")"
if [ "$version" != "$expected" ]; then
  echo "FAIL: fitc4 --version printed '$version', manifest says '$expected'" >&2
  exit 1
fi

echo "smoke: OK ($version)"
