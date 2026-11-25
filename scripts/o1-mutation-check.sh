#!/usr/bin/env sh
# O1 targeted mutations. Thin, portable (macOS and Linux) entry point: all the logic is in o1-mutation-check.mjs.
# Exit status 0 only if the baseline passes and every mutant is killed; anything else fails.
cd "$(dirname "$0")/.." || exit 2
exec node scripts/o1-mutation-check.mjs "$@"
