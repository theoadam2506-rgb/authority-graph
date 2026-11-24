# Frozen reference engine (oracle)

`tests/oracle/engine/` is a **verbatim copy of `src/engine/*.ts` at commit `b6046ec`** (origin/main before the O1 performance
change), with only the import path of `../domain/` rewritten so it can live under `tests/`. It is **never imported by
production code** and **must never be edited to follow `src/engine`**: its whole purpose is to stay the unoptimized
reference against which the optimized engine is compared (differential tests in `tests/engine/o1Differential.test.ts`).
If the reference behaviour must change, that is a deliberate, reviewed decision, not an update to keep tests green.
