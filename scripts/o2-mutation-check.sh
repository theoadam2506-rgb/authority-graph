#!/usr/bin/env sh
# O2-1 targeted mutations. Thin, portable entry point; all the logic is in mutation-runner.mjs.
cd "$(dirname "$0")/.." || exit 2
exec node scripts/o2-mutation-check.mjs "$@"
