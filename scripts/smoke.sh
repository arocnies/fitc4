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

echo "== clean project passes"
(cd "$consumer" && npx fitc4)

echo "== violation fails"
printf "import { status } from '../interface/index.ts'\nexport const bad = status\n" \
  > "$consumer/src/core/bad.ts"
if (cd "$consumer" && npx fitc4); then
  echo "FAIL: expected a non-zero exit for an undeclared dependency" >&2
  exit 1
fi
rm "$consumer/src/core/bad.ts"

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
