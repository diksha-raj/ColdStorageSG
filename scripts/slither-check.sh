#!/usr/bin/env bash
# Runs Slither on contracts/ (excluding OpenZeppelin) and fails if it reports anything that
# isn't in contracts/slither-baseline.txt. Findings are compared without line numbers, so edits
# that only move code don't show up as new.
#
#   npm run slither                 check for new findings
#   npm run slither -- --update     accept the current findings as the new baseline
#
# Needs Slither: pipx install slither-analyzer   (it finds the Hardhat build on its own)
set -uo pipefail
cd "$(dirname "$0")/../contracts"
export PATH="$HOME/.local/bin:$PATH"
command -v slither >/dev/null || { echo "Slither not found. Install it: pipx install slither-analyzer"; exit 1; }

BASELINE=slither-baseline.txt
OUT=$(mktemp)
trap 'rm -f "$OUT" "$OUT.json"' EXIT

slither . --filter-paths node_modules --json "$OUT.json" > /dev/null 2>&1
jq -e '.success' "$OUT.json" > /dev/null 2>&1 || { echo "Slither failed to run:"; slither . --filter-paths node_modules 2>&1 | tail -20; exit 1; }

# One line per finding: "<detector> | <description>", line numbers and whitespace normalised.
jq -r '.results.detectors[]? | [.check, (.description | gsub("#[0-9]+(-[0-9]+)?"; "") | gsub("\\s+"; " "))] | join(" | ")' "$OUT.json" \
  | sort > "$OUT"

if [ "${1:-}" = "--update" ]; then
  cp "$OUT" "$BASELINE"
  echo "Baseline updated: $(wc -l < "$BASELINE" | tr -d ' ') accepted finding(s) in contracts/$BASELINE"
  exit 0
fi

NEW=$(comm -13 "$BASELINE" "$OUT")
GONE=$(comm -23 "$BASELINE" "$OUT" | wc -l | tr -d ' ')
if [ -n "$NEW" ]; then
  echo "✖ Slither: new finding(s) not in the baseline:"
  echo "$NEW" | sed 's/^/  - /'
  echo "Fix them, or if a finding is intended, justify it in docs/decisions.md and run: npm run slither -- --update"
  exit 1
fi
echo "✔ Slither: no new findings ($(wc -l < "$OUT" | tr -d ' ') known, ${GONE} resolved since the baseline)"
