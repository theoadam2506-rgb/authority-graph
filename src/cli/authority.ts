#!/usr/bin/env node
/**
 * `authority explain <action_id>` (PROMPT 4, point 5).
 *
 * This file is I/O at the edges (reading a file or a database, reading the
 * wall clock for "now", printing to stdout) wrapped around exactly one call
 * into the pure engine (`explain()`, src/engine/explainAction.ts) — it
 * performs no authority computation of its own. If you find yourself
 * re-deriving AUTHORIZED/DENIED/REQUIRES_APPROVAL/UNKNOWN here instead of
 * reading it off the `ExplanationReport` explain() already produced, stop:
 * that would be exactly the mistake PROMPT 4 point 4 warns against.
 *
 * I17 (assurance-level honesty): every rendered sentence about an approval,
 * grant, denial, or revocation says "the log contains an event asserting
 * that X did Y", never "X proved" or "X is authorized to" as a bare fact.
 *
 * No UI, no HTTP server, no auth, no multi-tenant. Two event sources only:
 * a JSON file dump of an already-canonical event log (`--events <path>`),
 * or a live Postgres store (`--db <connection-string>` / `DATABASE_URL`).
 */
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import type { CanonicalStore } from "../domain/events.js";
import { actionId as toActionId, iso8601, sequenceNumber, type AuthorityDecision, type AuthorityInstant } from "../domain/types.js";
import {
  asAvailableChainResult,
  explain,
  type ApprovalDetail,
  type AvailableAuthorityChain,
  type ChainLinkDetail,
  type ExplanationReport,
  type InvokedCanonicalChain,
  type LateOrBackdatedObservation,
  type RecordedDelegationReference,
} from "../engine/explainAction.js";
import { PostgresEventStore } from "../storage/postgresEventStore.js";

// ---------------------------------------------------------------------------
// Argument parsing — hand-rolled on purpose: one subcommand, five flags, not
// worth a dependency.
// ---------------------------------------------------------------------------

interface ParsedArgs {
  readonly actionId: string;
  readonly json: boolean;
  readonly eventsPath?: string;
  readonly dbUrl?: string;
  readonly atSequence?: number;
  readonly authorityTime?: string;
  readonly clockDriftThresholdMs?: number;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv[0] !== "explain" || argv[1] === undefined) {
    throw new Error(
      "Usage: authority explain <action_id> [--json] [--events <path> | --db <connection-string>] [--at-sequence <n>] [--authority-time <iso8601>] [--clock-drift-threshold-ms <n>]",
    );
  }
  let json = false;
  let eventsPath: string | undefined;
  let dbUrl: string | undefined;
  let atSequence: number | undefined;
  let authorityTime: string | undefined;
  let clockDriftThresholdMs: number | undefined;

  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`Missing value for ${flag}`);
      }
      return value;
    };
    switch (flag) {
      case "--json":
        json = true;
        break;
      case "--events":
        eventsPath = next();
        break;
      case "--db":
        dbUrl = next();
        break;
      case "--at-sequence":
        atSequence = Number(next());
        break;
      case "--authority-time":
        authorityTime = next();
        break;
      case "--clock-drift-threshold-ms":
        clockDriftThresholdMs = Number(next());
        break;
      default:
        throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return {
    actionId: argv[1],
    json,
    ...(eventsPath !== undefined ? { eventsPath } : {}),
    ...(dbUrl !== undefined ? { dbUrl } : {}),
    ...(atSequence !== undefined ? { atSequence } : {}),
    ...(authorityTime !== undefined ? { authorityTime } : {}),
    ...(clockDriftThresholdMs !== undefined ? { clockDriftThresholdMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Event source resolution
// ---------------------------------------------------------------------------

/**
 * "imported canonical event export" (not "validated"): a `--events` file is
 * someone's prior dump of a canonical log. This CLI never re-runs I12/I13/I14
 * against it and must never imply it has — the source label below exists
 * specifically so nobody mistakes "the CLI read a JSON file" for "Authority
 * vouches for this file's contents". `assurance_level` on every event stays
 * `ASSERTED_UNVERIFIED` regardless of which source produced it (I17): V0 has
 * no signature scheme, so importing a file changes provenance, not trust.
 */
export type EventSourceLabel = "imported canonical event export" | "postgres store (live)";

interface LoadedEvents {
  readonly events: CanonicalStore;
  readonly source: EventSourceLabel;
}

async function loadEventsFromFile(path: string): Promise<CanonicalStore> {
  const raw = await readFile(path, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON array of events`);
  }
  // This file is expected to be a dump of an already-canonical event log
  // (e.g. InMemoryEventStore/PostgresEventStore's own getEvents() output) —
  // sequence/authority_time/recorded_at were already assigned at ingestion,
  // not by this CLI. No re-validation of I12/I13/I14 happens here: that
  // already happened once, at ingestion, and is not this command's job.
  return parsed as CanonicalStore;
}

async function loadEventsFromPostgres(connectionString: string): Promise<CanonicalStore> {
  const pool = new Pool({ connectionString });
  try {
    const store = new PostgresEventStore(pool, { authorityTime: () => iso8601(new Date().toISOString()) });
    return await store.getEvents();
  } finally {
    await pool.end();
  }
}

async function loadEvents(args: ParsedArgs): Promise<LoadedEvents> {
  if (args.eventsPath !== undefined) {
    return { events: await loadEventsFromFile(args.eventsPath), source: "imported canonical event export" };
  }
  const dbUrl = args.dbUrl ?? process.env["DATABASE_URL"];
  if (dbUrl !== undefined) {
    return { events: await loadEventsFromPostgres(dbUrl), source: "postgres store (live)" };
  }
  throw new Error("No event source given: pass --events <path> or --db <connection-string> (or set DATABASE_URL).");
}

function resolveCurrentInstant(args: ParsedArgs, events: CanonicalStore): AuthorityInstant {
  const latestSequence = events.reduce((max, e) => (e.sequence > max ? e.sequence : max), 0);
  const atSequence = args.atSequence !== undefined ? sequenceNumber(args.atSequence) : sequenceNumber(latestSequence);
  const authorityTime = args.authorityTime !== undefined ? iso8601(args.authorityTime) : iso8601(new Date().toISOString());
  return { atSequence, authorityTime };
}

// ---------------------------------------------------------------------------
// Rendering — text and JSON. Purely presentational: reads fields off the
// ExplanationReport, computes nothing about authority.
// ---------------------------------------------------------------------------

function describeOutcome(decision: AuthorityDecision): string {
  return decision.outcome;
}

const REASON_CODE_GLOSS: Readonly<Record<string, string>> = {
  C5_APPROVAL_DENIED_BY_GRANTOR: "the log contains an event asserting that the delegation's own grantor denied this action's approval",
  C6_ACTION_FINGERPRINT_MISMATCH: "the executed action's fingerprint does not match what was originally requested",
  C7_APPROVAL_ALREADY_CONSUMED: "the approval this execution relies on had already been consumed by a prior execution",
  C8_AMOUNT_EXCEEDS_APPROVAL_CEILING: "the requested amount exceeds the approval ceiling for this delegation",
  C9_TOTAL_BUDGET_EXCEEDED: "this delegation's total_budget is exhausted by prior executions",
  C11_CAPABILITY_NOT_COVERED: "no valid delegation chain covers the requested capability",
  C12_DELEGATION_REVOKED: "the log contains a DELEGATION_REVOKED event for a delegation in this chain",
};

function reasonGloss(reasonCode: string): string {
  return REASON_CODE_GLOSS[reasonCode] ?? "see SPEC.md for this reason code";
}

function renderDecisionDetail(decision: AuthorityDecision): string[] {
  if (decision.outcome === "DENIED" || decision.outcome === "UNKNOWN") {
    return [`  reason: ${decision.reasonCode}: ${reasonGloss(decision.reasonCode)}`];
  }
  if (decision.outcome === "REQUIRES_APPROVAL") {
    return [`  pending approval via delegation ${decision.viaDelegation}`];
  }
  return [];
}

function renderChainLinkLines(chain: readonly ChainLinkDetail[]): string[] {
  const lines: string[] = [];
  for (const link of chain) {
    lines.push(
      `  - delegation ${link.delegationId}: ${link.grantorPrincipalId}${link.grantorType !== undefined ? ` (${link.grantorType})` : ""} -> ${link.granteePrincipalId} (granted at sequence ${link.grantedAtSequence})`,
    );
    lines.push(`      capabilities: ${link.capabilities.map((c) => `${c.resource}.${c.action}`).join(", ")}`);
    lines.push(`      can_delegate: ${link.canDelegate}`);
    lines.push(`      expires_at: ${link.expiresAt.kind === "at" ? link.expiresAt.value : "no_expiry"}`);
    if (link.maxAmount !== undefined) {
      lines.push(`      max_amount: ${link.maxAmount.value} ${link.maxAmount.currency}`);
    }
    if (link.totalBudget !== undefined) {
      lines.push(`      total_budget: ${link.totalBudget.value} ${link.totalBudget.currency}`);
    }
    if (link.thresholds !== undefined) {
      lines.push(`      thresholds: automatic<=${link.thresholds.automatic_max_amount}, approval<=${link.thresholds.approval_max_amount}`);
    }
    if (link.revocations.length === 0) {
      lines.push("      revocations: none");
    } else {
      for (const r of link.revocations) {
        lines.push(`      revocation: the log contains a DELEGATION_REVOKED event asserting that ${r.byPrincipalId} revoked this delegation at sequence ${r.bySequence} (reason: ${r.reasonCode})`);
      }
    }
  }
  return lines;
}

function renderNonAuthorizedOutcome(decision: Exclude<AuthorityDecision, { readonly outcome: "AUTHORIZED" }>): string {
  if (decision.outcome === "REQUIRES_APPROVAL") {
    return `REQUIRES_APPROVAL: pending approval via delegation ${decision.viaDelegation}`;
  }
  return `${decision.outcome}: ${decision.reasonCode}: ${reasonGloss(decision.reasonCode)}`;
}

/** Renders one of the two AVAILABLE-chain sections ("... at decision" / "... now"). Never a blank body: "none"/"unresolvable" always print the actual decision, not an empty section. */
function renderAvailableChainSection(title: string, result: AvailableAuthorityChain): string[] {
  const lines = [`${title}:`];
  if (result.kind === "resolved") {
    lines.push(...renderChainLinkLines(result.chain));
  } else if (result.kind === "none") {
    lines.push(`  none — ${renderNonAuthorizedOutcome(result.decision)}`);
  } else {
    lines.push("  unresolvable — the decision is AUTHORIZED but a delegation in its chain has no resolvable detail in the visible events");
  }
  return lines;
}

/** Renders one of the two INVOKED-canonical-chain sections. Structural, verdict-independent: resolves even under REQUIRES_APPROVAL/DENIED/UNKNOWN. */
function renderInvokedChainSection(title: string, result: InvokedCanonicalChain): string[] {
  const lines = [`${title}:`];
  if (result.kind === "resolved") {
    lines.push(...renderChainLinkLines(result.chain));
  } else {
    lines.push("  unresolvable — the invoked delegation's canonical ancestry could not be reconstructed from the visible events");
  }
  return lines;
}

function renderRecordedReferences(refs: readonly RecordedDelegationReference[]): string[] {
  const lines = ["Recorded delegation references:"];
  if (refs.length === 0) {
    lines.push("  none");
    return lines;
  }
  for (const ref of refs) {
    lines.push(
      ref.detail !== undefined
        ? `  - delegation ${ref.delegationId}: ${ref.detail.grantorPrincipalId} -> ${ref.detail.granteePrincipalId}`
        : `  - delegation ${ref.delegationId}: (no resolvable detail in the visible events)`,
    );
  }
  return lines;
}

function renderApprovals(approvals: readonly ApprovalDetail[]): string[] {
  if (approvals.length === 0) {
    return ["Approvals: none requested for this action"];
  }
  const lines = ["Approvals:"];
  for (const a of approvals) {
    lines.push(`  - approval ${a.approvalId} (requested at sequence ${a.requestedAtSequence} from ${a.requestedFromPrincipalId})`);
    if (a.decision === undefined) {
      lines.push("      no decision recorded yet");
    } else if (a.decision.outcome === "GRANTED") {
      lines.push(`      the log contains an event asserting that ${a.decision.byPrincipalId} granted this approval at sequence ${a.decision.atSequence}`);
    } else {
      lines.push(`      the log contains an event asserting that ${a.decision.byPrincipalId} denied this approval at sequence ${a.decision.atSequence} (reason: ${a.decision.reasonCode ?? "unspecified"})`);
    }
  }
  return lines;
}

function renderClockDrift(observations: readonly LateOrBackdatedObservation[]): string[] {
  if (observations.length === 0) {
    return ["Clock drift diagnostics: no LATE_OR_BACKDATED_EVENT_OBSERVED signal"];
  }
  const lines = ["Clock drift diagnostics:"];
  for (const o of observations) {
    lines.push(`  LATE_OR_BACKDATED_EVENT_OBSERVED: ${o.eventType} (${o.eventId}): |authority_time - occurred_at| = ${o.driftMs}ms (authority_time: ${o.authorityTime}, occurred_at: ${o.occurredAt})`);
  }
  return lines;
}

function renderText(report: ExplanationReport, current: AuthorityInstant, source: EventSourceLabel): string {
  const lines: string[] = [`source: ${source}`];

  if (report.execution !== undefined) {
    lines.push(`ACTION_EXECUTED at sequence ${report.execution.executedAtSequence}`);
    lines.push(`authority at decision sequence ${report.execution.decisionSequence}: ${describeOutcome(report.execution.authorityAtDecision)}`);
    lines.push(...renderDecisionDetail(report.execution.authorityAtDecision));
    if (report.execution.consumedApprovalId !== undefined) {
      lines.push(`approval consumed by execution ${report.execution.executedAtSequence}`);
    }
  } else {
    lines.push(`ACTION_REQUESTED at sequence ${report.requestedAtSequence} (not yet executed)`);
  }
  lines.push(`current authority at sequence ${current.atSequence}: ${describeOutcome(report.currentAuthority)}`);
  lines.push(...renderDecisionDetail(report.currentAuthority));

  lines.push("");
  if (report.execution !== undefined) {
    lines.push(...renderAvailableChainSection("Available chain at decision", asAvailableChainResult(report.execution.authorityAtDecision, report.chain)));
    lines.push("");
    lines.push(...renderInvokedChainSection("Invoked canonical chain at decision", report.execution.invokedCanonicalChainAtDecision));
    lines.push("");
    lines.push(...renderRecordedReferences(report.recordedDelegationReferences ?? []));
    lines.push("");
  }
  lines.push(...renderAvailableChainSection("Available chain now", report.availableChainNow));
  lines.push("");
  lines.push(...renderInvokedChainSection("Invoked canonical chain now", report.invokedCanonicalChainNow));

  lines.push("");
  lines.push(...renderApprovals(report.approvals));
  lines.push("");
  lines.push(...renderClockDrift(report.lateOrBackdatedEvents));
  lines.push("");
  lines.push(`assurance_level: ${report.assuranceLevel}: no cryptographic signature or verified identity backs any event in this log (I17); every claim above is "the log contains an event asserting", never a proof.`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs the whole `explain` command and returns its output instead of writing
 * to stdout/stderr — the actual process entry point below is a thin wrapper
 * around this. Exported so callers that need the real CLI's exact output in
 * hand (demo/run.ts's closing "explain historique" step; a future test) can
 * get it in-process, without spawning a subprocess or re-implementing any of
 * the rendering above.
 */
export async function runExplain(argv: readonly string[]): Promise<{ readonly exitCode: number; readonly output: string }> {
  const args = parseArgs(argv);
  const { events, source } = await loadEvents(args);
  const actionId = toActionId(args.actionId);

  const hasRequest = events.some((e) => e.event_type === "ACTION_REQUESTED" && e.payload.action_id === actionId);
  if (!hasRequest) {
    return { exitCode: 1, output: `No ACTION_REQUESTED event found for action_id "${args.actionId}" in this log (source: ${source}).\n` };
  }

  const current = resolveCurrentInstant(args, events);
  const report = explain(events, { actionId }, current, args.clockDriftThresholdMs !== undefined ? { clockDriftThresholdMs: args.clockDriftThresholdMs } : undefined);

  const output = args.json ? `${JSON.stringify({ source, ...report }, null, 2)}\n` : `${renderText(report, current, source)}\n`;
  return { exitCode: 0, output };
}

async function main(argv: readonly string[]): Promise<number> {
  const { exitCode, output } = await runExplain(argv);
  if (exitCode === 0) {
    process.stdout.write(output);
  } else {
    process.stderr.write(output);
  }
  return exitCode;
}

// Only auto-run when this file is the process entry point — importing
// `runExplain` (or `main`) from another module (demo/run.ts) must never
// trigger a second, argv-mismatched invocation.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
