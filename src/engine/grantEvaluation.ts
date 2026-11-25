/**
 * B1 — how the historical grants are evaluated, and how that is rolled out.
 *
 * `collectValidatedGrants(store)` returns the grants `validateAndSelectGrant` accepts, in journal order. Three modes:
 *
 *   "historical"  the original loop, one full re-validation per grant (the DEFAULT: nothing changes unless a mode is chosen);
 *   "one-pass"    onePassGrants.ts when its guard accepts the journal, the historical loop otherwise;
 *   "shadow"      the historical result is RETURNED AND USED; the one-pass result is computed next to it, compared, and a
 *                 mismatch is counted and reported. The one-pass result is never returned in this mode, so no decision is
 *                 ever taken from an unvalidated result. It runs only on journals up to `shadowMaxEvents` (the historical loop
 *                 it needs for the comparison is quadratic); above that the call is plain "historical".
 *
 * Operational limit on the historical path (OFF by default). The historical loop is quadratic, so on a large journal it can take
 * minutes. `limits` makes it stop EARLY with `GrantEvaluationLimitExceeded`: an exception, never a business decision. The SDK maps any
 * exception raised while deciding to `UNAVAILABLE` (the operator's `onDiagnostic` hook receives the cause, whose class and `code`
 * name this limit), so a time-out is explicit and traceable and can never be read as a refusal.
 *
 * The mode can be set by the host with `configureGrantEvaluation` (an engine-level function, not part of the SDK's public surface) or,
 * at start-up, with the environment variable AUTHORITY_GRANT_EVALUATION = historical | shadow | one-pass (anything else throws).
 */
import type { CanonicalStore } from "../domain/events.js";
import type { ValidatedGrant } from "./capacity.js";
import { validateAndSelectGrant } from "./grantValidation.js";
import { collectValidatedGrantsOnePass, onePassGuard, type OnePassRefusal } from "./onePassGrants.js";

export type GrantEvaluationMode = "historical" | "shadow" | "one-pass";

export class GrantEvaluationLimitExceeded extends Error {
  readonly code: "GRANT_EVALUATION_WORK_LIMIT" | "GRANT_EVALUATION_DEADLINE";
  readonly grants: number;
  readonly events: number;
  constructor(code: GrantEvaluationLimitExceeded["code"], message: string, grants: number, events: number) {
    super(message);
    this.name = "GrantEvaluationLimitExceeded";
    this.code = code;
    this.grants = grants;
    this.events = events;
  }
}

export interface GrantEvaluationLimits {
  /** Refuse to start the historical loop when `grants x events` exceeds this (an estimate of its work, known before it starts). */
  readonly maxWork?: number;
  /** Stop the historical loop, between two grants, once this many milliseconds have elapsed. */
  readonly deadlineMs?: number;
  /** Injected clock for the deadline (milliseconds). Default: performance.now. */
  readonly now?: () => number;
}

export interface ShadowMismatch {
  readonly events: number;
  readonly historical: readonly string[];
  readonly onePass: readonly string[] | undefined;
}

export interface GrantEvaluationConfig {
  readonly mode: GrantEvaluationMode;
  readonly limits?: GrantEvaluationLimits;
  readonly shadowMaxEvents: number;
  readonly onShadowMismatch?: (mismatch: ShadowMismatch) => void;
}

export interface GrantEvaluationStats {
  onePassRuns: number;
  historicalRuns: number;
  guardRefusals: Record<OnePassRefusal, number>;
  shadowComparisons: number;
  shadowMismatches: number;
  shadowSkippedTooLarge: number;
}

const DEFAULT_SHADOW_MAX_EVENTS = 5_000;

function modeFromEnvironment(): GrantEvaluationMode {
  const value = process.env["AUTHORITY_GRANT_EVALUATION"];
  if (value === undefined || value === "") return "historical";
  if (value === "historical" || value === "shadow" || value === "one-pass") return value;
  throw new Error(`AUTHORITY_GRANT_EVALUATION must be historical, shadow or one-pass (got ${JSON.stringify(value)})`);
}

let config: GrantEvaluationConfig = { mode: modeFromEnvironment(), shadowMaxEvents: DEFAULT_SHADOW_MAX_EVENTS };
const emptyStats = (): GrantEvaluationStats => ({ onePassRuns: 0, historicalRuns: 0, guardRefusals: { NOT_SHAPE_SOUND: 0, SEQUENCE_NOT_STRICTLY_INCREASING: 0, LATE_ACTIVATION: 0 }, shadowComparisons: 0, shadowMismatches: 0, shadowSkippedTooLarge: 0 });
let stats = emptyStats();

export function configureGrantEvaluation(next: Partial<GrantEvaluationConfig>): void {
  config = { ...config, ...next };
}
export function resetGrantEvaluation(): void {
  config = { mode: modeFromEnvironment(), shadowMaxEvents: DEFAULT_SHADOW_MAX_EVENTS };
  stats = emptyStats();
}
export function getGrantEvaluationConfig(): GrantEvaluationConfig {
  return config;
}
export function getGrantEvaluationStats(): Readonly<GrantEvaluationStats> {
  return { ...stats, guardRefusals: { ...stats.guardRefusals } };
}
export function resetGrantEvaluationStats(): void {
  stats = emptyStats();
}

/**
 * The original loop of issueCapability.ts, plus the optional operational limits. With no limit it is that loop, unchanged.
 *
 * It re-derives every already-issued grant by re-running `validateAndSelectGrant` against each CAPABILITY_ISSUED event (see
 * capacity.ts: no factory skips validation) and is deliberately expensive (one full re-validation per grant) rather than trusting
 * persisted events at face value: once CAPABILITY_ISSUED events can only come from a validated atomic transaction, re-validating
 * them on every read is redundant; until then re-checking is the honest choice.
 */
export function collectValidatedGrantsHistorical(store: CanonicalStore, limits?: GrantEvaluationLimits): readonly ValidatedGrant[] {
  const grants: ValidatedGrant[] = [];
  let candidates = 0;
  if (limits !== undefined) {
    for (const event of store) if (event.event_type === "CAPABILITY_ISSUED") candidates += 1;
    if (limits.maxWork !== undefined && candidates * store.length > limits.maxWork) {
      throw new GrantEvaluationLimitExceeded("GRANT_EVALUATION_WORK_LIMIT", `the historical grant evaluation would cost about ${candidates * store.length} steps (${candidates} grants x ${store.length} events), above the limit ${limits.maxWork}`, candidates, store.length);
    }
  }
  const now = limits?.now ?? (() => performance.now());
  const started = limits?.deadlineMs !== undefined ? now() : 0;
  for (const event of store) {
    if (event.event_type !== "CAPABILITY_ISSUED") {
      continue;
    }
    if (limits?.deadlineMs !== undefined && now() - started > limits.deadlineMs) {
      throw new GrantEvaluationLimitExceeded("GRANT_EVALUATION_DEADLINE", `the historical grant evaluation exceeded ${limits.deadlineMs} ms after ${grants.length} accepted grants`, candidates, store.length);
    }
    const result = validateAndSelectGrant(store, event);
    if (result.ok) {
      grants.push(result.grant);
    }
  }
  return grants;
}

const ids = (grants: readonly ValidatedGrant[]): string[] => grants.map((g) => g.event.event_id);

/** The two evaluators side by side, for tests and offline tooling. Never used to decide anything. */
export function compareGrantEvaluators(store: CanonicalStore): { readonly guard: OnePassRefusal | "ACCEPTED"; readonly equal: boolean | undefined; readonly historical: readonly string[]; readonly onePass: readonly string[] | undefined } {
  const historical = ids(collectValidatedGrantsHistorical(store));
  const guard = onePassGuard(store);
  if (!guard.ok) return { guard: guard.reason, equal: undefined, historical, onePass: undefined };
  const onePass = ids(collectValidatedGrantsOnePass(store, guard) ?? []);
  return { guard: "ACCEPTED", equal: historical.length === onePass.length && historical.every((id, i) => id === onePass[i]), historical, onePass };
}

export function collectValidatedGrants(store: CanonicalStore): readonly ValidatedGrant[] {
  const { mode, limits } = config;
  if (mode === "historical") {
    stats.historicalRuns += 1;
    return collectValidatedGrantsHistorical(store, limits);
  }
  if (mode === "one-pass") {
    const guard = onePassGuard(store);
    if (guard.ok) {
      stats.onePassRuns += 1;
      return collectValidatedGrantsOnePass(store, guard) ?? collectValidatedGrantsHistorical(store, limits);
    }
    stats.guardRefusals[guard.reason] += 1;
    stats.historicalRuns += 1;
    return collectValidatedGrantsHistorical(store, limits);
  }
  // shadow: the decision is taken from the historical result, always
  stats.historicalRuns += 1;
  const historical = collectValidatedGrantsHistorical(store, limits);
  if (store.length > config.shadowMaxEvents) {
    stats.shadowSkippedTooLarge += 1;
    return historical;
  }
  const guard = onePassGuard(store);
  if (!guard.ok) {
    stats.guardRefusals[guard.reason] += 1;
    return historical;
  }
  const candidate = collectValidatedGrantsOnePass(store, guard);
  stats.shadowComparisons += 1;
  const a = ids(historical);
  const b = candidate === undefined ? undefined : ids(candidate);
  if (b === undefined || a.length !== b.length || a.some((id, i) => id !== b[i])) {
    stats.shadowMismatches += 1;
    try {
      config.onShadowMismatch?.({ events: store.length, historical: a, onePass: b });
    } catch {
      // an operator hook must never change a decision
    }
  }
  return historical;
}
