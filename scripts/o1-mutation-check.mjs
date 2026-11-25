#!/usr/bin/env node
/** O1 targeted mutations: see scripts/mutation-runner.mjs for the rules (every mutant must be killed; non-zero exit otherwise). */
import { runMutants } from "./mutation-runner.mjs";

/** [name, file, from, to, expected occurrences] */
const MUTANTS = [
  ["shape check always true", "src/engine/issueCapability.ts", "const lazyGrants = isJournalShapeSound(store);", "const lazyGrants = true;", 1],
  ["shape check ignores granted_chain_ref", "src/engine/journalShape.ts", "isInt(p.decision_sequence) && isChain(p.granted_chain_ref)", "isInt(p.decision_sequence)", 1],
  ["shape check ignores expires_at of a grant", "src/engine/journalShape.ts", "isStr(p.enforcement_point_id) && isStr(p.expires_at);", "isStr(p.enforcement_point_id);", 1],
  ["shape check ignores capabilities arrays", "src/engine/journalShape.ts", "Array.isArray(p.capabilities) && p.capabilities.every(isCapability)", "true", 2],
  ["shape check ignores constraints", "src/engine/journalShape.ts", "return isConstraints(p) && ", "return ", 2],
  ["shape check ignores ACTION_REQUESTED payload", "src/engine/journalShape.ts", "isCapability(p.capability_requested) && isWellFormedActionParameters(p.parameters)", "true", 1],
  ["shape check ignores execution_result", "src/engine/journalShape.ts", " && isStr(p.execution_result);", ";", 1],
  ["grants never collected for a bounded delegation", "src/engine/issueCapability.ts", "existingGrants ??= collectValidatedGrants(store);", "existingGrants ??= [];", 1],
  ["action index returns the LAST match", "src/engine/journalIndex.ts", "if (!this.actions.has(key)) this.actions.set(key, event);", "this.actions.set(key, event);", 1],
  ["delegation index returns the LAST match", "src/engine/journalIndex.ts", "if (!this.delegations.has(key)) this.delegations.set(key, event);", "this.delegations.set(key, event);", 1],
  ["index never falls back (swallows anomalies)", "src/engine/journalIndex.ts", "this.unsafe = true;", "this.unsafe = false;", 1],
  ["index ignores SUBDELEGATION_CREATED", "src/engine/journalIndex.ts", 'type === "DELEGATION_CREATED" || type === "SUBDELEGATION_CREATED"', 'type === "DELEGATION_CREATED"', 1],
  ["capacity lookup bypassed", "src/engine/capacity.ts", "lookup.actionRequested(grant.event.payload.action_id, (id) => findActionRequested(id, visibleStore))", "undefined", 1],
];


process.exit(runMutants({
  tests: ["tests/engine/o1Differential.test.ts", "tests/engine/o1Targeted.test.ts"],
  env: { O1_JOURNALS: process.env.O1_JOURNALS ?? "400" },
  mutants: MUTANTS,
}));
