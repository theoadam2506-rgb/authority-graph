#!/usr/bin/env bash
# O1 targeted mutations: each mutant of the optimization MUST be caught by the differential tests (the test run must FAIL).
# Usage: scripts/o1-mutation-check.sh   (restores every file it touches; needs a clean worktree for the touched files)
set -u
cd "$(dirname "$0")/.."
export O1_JOURNALS="${O1_JOURNALS:-400}"
survived=0
run_mutant () { # name file sed-expression
  local name="$1" file="$2" expr="$3"
  cp "$file" "$file.orig"
  sed -i -E "$expr" "$file"
  if cmp -s "$file" "$file.orig"; then echo "MUTANT $name: sed changed nothing (broken mutant definition)"; mv "$file.orig" "$file"; survived=$((survived+1)); return; fi
  if npx vitest run tests/engine/o1Differential.test.ts tests/engine/o1Targeted.test.ts >/tmp/o1-mutant.log 2>&1; then echo "MUTANT $name: SURVIVED (tests still pass)  <-- gap"; survived=$((survived+1)); else echo "MUTANT $name: killed"; fi
  mv "$file.orig" "$file"
}
run_mutant "shape check always true"            src/engine/issueCapability.ts 's/const lazyGrants = isJournalShapeSound\(store\);/const lazyGrants = true;/'
run_mutant "shape check ignores chain links"    src/engine/journalShape.ts    's/isStr\(p.enforcement_point_id\) \&\& isStr\(p.expires_at\);/isStr(p.enforcement_point_id);/; s/isInt\(p.decision_sequence\) \&\& isChain\(p.granted_chain_ref\)/isInt(p.decision_sequence)/'
run_mutant "shape check ignores capabilities arrays" src/engine/journalShape.ts 's/Array.isArray\(p.capabilities\) \&\& p.capabilities.every\(isCapability\)/true/g'
run_mutant "shape check ignores constraints"      src/engine/journalShape.ts  's/return isConstraints\(p\) \&\& /return /g'
run_mutant "shape check ignores ACTION_REQUESTED payload" src/engine/journalShape.ts 's/isCapability\(p.capability_requested\) \&\& isWellFormedActionParameters\(p.parameters\)/true/'
run_mutant "grants never collected for bounded"  src/engine/issueCapability.ts 's/existingGrants \?\?= collectValidatedGrants\(store\);/existingGrants ??= [];/'
run_mutant "index returns LAST match"            src/engine/journalIndex.ts    's/if \(!this.actions.has\(key\)\) this.actions.set\(key, event\);/this.actions.set(key, event);/'
run_mutant "delegation index returns LAST match" src/engine/journalIndex.ts    's/if \(!this.delegations.has\(key\)\) this.delegations.set\(key, event\);/this.delegations.set(key, event);/'
run_mutant "index never falls back (swallows anomalies)" src/engine/journalIndex.ts 's/this.unsafe = true;/this.unsafe = false;/'
run_mutant "index ignores SUBDELEGATION"         src/engine/journalIndex.ts    's/type === "DELEGATION_CREATED" \|\| type === "SUBDELEGATION_CREATED"/type === "DELEGATION_CREATED"/'
run_mutant "capacity index bypassed wrongly"     src/engine/capacity.ts        's/lookup.actionRequested\(grant.event.payload.action_id, \(id\) => findActionRequested\(id, visibleStore\)\)/undefined/'
echo "surviving or broken mutants: $survived"
exit $survived
