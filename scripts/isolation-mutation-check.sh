#!/usr/bin/env sh
# Isolation / broken-connection mutations (needs PostgreSQL via TEST_DATABASE_URL). Exit 0 only if the baseline passes and every mutant is killed.
cd "$(dirname "$0")/.." || exit 2
exec node scripts/isolation-mutation-check.mjs "$@"
