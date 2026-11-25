#!/usr/bin/env sh
# B1 targeted mutations. Thin, portable entry point; exit 0 only if the baseline passes and every mutant is killed.
cd "$(dirname "$0")/.." || exit 2
exec node scripts/b1-mutation-check.mjs "$@"
