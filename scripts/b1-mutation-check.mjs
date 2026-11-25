#!/usr/bin/env node
/** B1 targeted mutations of the one-pass evaluator and its dispatcher: every mutant must be killed (see scripts/mutation-runner.mjs). */
import { runMutants } from "./mutation-runner.mjs";

const OP = "src/engine/onePassGrants.ts";
const GE = "src/engine/grantEvaluation.ts";
/** [name, file, from, to, expected occurrences] */
const MUTANTS = [
  ["guard: execution before its request is accepted", OP, 'if (request.sequence > event.sequence) return { ok: false, reason: "LATE_ACTIVATION", at: i };', "", 1],
  ["guard: execution before a delegation of its chain is accepted", OP, 'if (node.sequence > event.sequence) return { ok: false, reason: "LATE_ACTIVATION", at: i };', "", 1],
  ["guard: non-increasing sequences accepted", OP, "if (!(sequence > previous)) {", "if (false) {", 1],
  ["guard: shape check skipped", OP, "if (!isJournalShapeSound(store)) {", "if (false) {", 1],
  ["state: first request becomes last request", OP, "if (!this.firstRequest.has(event.payload.action_id)) this.firstRequest.set(event.payload.action_id, event);", "this.firstRequest.set(event.payload.action_id, event);", 1],
  ["state: first delegation becomes last delegation", OP, "if (!this.firstDelegation.has(event.payload.delegation_id)) this.firstDelegation.set(event.payload.delegation_id, event);", "this.firstDelegation.set(event.payload.delegation_id, event);", 1],
  ["state: debit charged twice per action", OP, "if (this.charged.has(key)) continue; // an action is debited once per delegation", "", 1],
  ["state: executions not tied to their executor are charged", OP, "if (!tied) continue;", "", 1],
  ["state: debit charged to delegations outside the ancestry", OP, "if (!ancestry.has(delegationId as DelegationId)) continue;", "", 1],
  ["state: currency ignored when summing debits", OP, "byCurrency.get(parameters.amount.currency) ?? 0", 'byCurrency.get("EUR") ?? 0', 1],
  ["state: only the direct grantor can revoke", OP, "(signers.has(directGrantor) || (rootGrantor !== undefined && signers.has(rootGrantor)))", "signers.has(directGrantor)", 1],
  ["state: revocation ignored", OP, "return signers !== undefined && (", "return false && signers !== undefined && (", 1],
  ["state: approvals reduction drops the executions", OP, "if (executions !== undefined) reduced.push(...executions);", "", 1],
  ["candidate: fingerprint not compared", OP, "if (candidate.payload.action_fingerprint !== computeActionFingerprint(request.payload.capability_requested, request.payload.parameters)) return false;", "", 1],
  ["candidate: decision sequence not compared", OP, "if (Number(candidate.payload.decision_sequence) !== snapshot) return false;", "", 1],
  ["candidate: granted chain not compared", OP, "return chainsEqual(candidate.payload.granted_chain_ref, granted);", "return true;", 1],
  ["candidate: grantee of the invoked delegation not compared", OP, "if (invoked.payload.grantee_principal_id !== request.payload.requesting_principal_id) return false;", "", 1],
  ["candidate: constraints not required to AUTHORIZE", OP, 'if (decision.outcome !== "AUTHORIZED") return false;', "", 1],
  ["dispatcher: a refused guard does not fall back", GE, "    stats.guardRefusals[guard.reason] += 1;\n    stats.historicalRuns += 1;\n    return collectValidatedGrantsHistorical(store, limits);", "    stats.guardRefusals[guard.reason] += 1;\n    return [];", 1],
  ["dispatcher: shadow does not compare", GE, "stats.shadowComparisons += 1;", "stats.shadowComparisons += 0;", 1],
  ["dispatcher: shadow size cap ignored", GE, "if (store.length > config.shadowMaxEvents) {", "if (false) {", 1],
  ["limits: work limit ignored", GE, "candidates * store.length > limits.maxWork", "false", 1],
  ["limits: deadline ignored", GE, "now() - started > limits.deadlineMs", "false", 1],
];

process.exit(runMutants({
  tests: ["tests/engine/b1Enumeration.test.ts", "tests/engine/b1Differential.test.ts", "tests/engine/b1Targeted.test.ts"],
  env: { B1_JOURNALS: process.env.B1_JOURNALS ?? "4000" },
  mutants: MUTANTS,
}));
