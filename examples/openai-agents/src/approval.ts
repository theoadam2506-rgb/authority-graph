/**
 * Architecture B, experimental: the host-side coordinator that connects the OpenAI Agents SDK's native approvals
 * (`needsApproval`, `interruptions`, `RunState`, `state.approve`, `state.reject`) to Authority.
 *
 * READ THIS FIRST. Nothing in this file is production-ready:
 *  - The store is IN MEMORY. A real one is durable, shared between processes, and makes every transition below an
 *    atomic conditional update (a transaction or a compare-and-set). Here "atomic" only means "no `await` between the
 *    check and the write inside one event loop".
 *  - The authenticator maps a TOKEN to a principal with a plain object. It is a simulation. A real one is the
 *    application's session or identity layer.
 *  - The serialized `RunState` is kept as a string in that memory. The Agents SDK documents that a snapshot contains
 *    tool arguments, approval decisions and application context, and that `RunState.fromString` does not authenticate
 *    it: a real deployment keeps it server side, verifies its integrity and binds it to the run and the user.
 *
 * What the design relies on, and what it does not:
 *  - ENFORCEMENT is `authority.guard()` inside the tool's `execute`. The SDK's pause and approval are a user-experience
 *    mechanism. A wrong, sticky (`alwaysApprove`) or missing SDK approval cannot make the effect run: `guard()` asks
 *    Authority again and refuses. This coordinator never passes `alwaysApprove`.
 *  - The reviewer is AUTHENTICATED (simulated) and then AUTHORIZED for the approval by the host (`authorizeReviewer`),
 *    before anything is claimed or written. Authority independently accepts an approval only from the grantor of the
 *    action's delegation, which stays a second layer.
 *  - The reviewer's DECISION is recorded in Authority and CHECKED (`outcomes[].accepted`).
 *  - The coordinator takes nothing from the reviewer but an approval id, a decision and a credential: the arguments, the
 *    action id, the call id and the snapshot come from its own store.
 *
 * ONE DECISION PER APPROVAL, AND WHAT THAT DOES AND DOES NOT MEAN.
 *  - A decision is CLAIMED with an unguessable claim token that also records its INTENT (approve or reject) and its
 *    reviewer. Every later transition of the claim must present the token, so a stale finisher cannot move the record.
 *  - A claim is NEVER given back to a state where a DIFFERENT decision can be taken once an Authority write has been
 *    attempted. A write whose outcome is not known leaves the approval `DECIDING`; it is neither retried by a different
 *    decision nor released to `PENDING`. Releasing it would let a reject follow an approve that may already be in
 *    Authority's journal, and a "rejected" order would later run (reproduced in the review of this example).
 *  - The only way out of `DECIDING` is `completeStuckDecision`, an explicit operator action that re-applies the SAME
 *    intent of the SAME reviewer (re-checking that reviewer's authorization and the binding to Authority). Repeating the
 *    same intent is harmless: a second approval, or a second refusal, adds nothing that the first did not.
 *  - What this CANNOT establish: an Authority write that is already in flight cannot be cancelled, and Authority offers no
 *    conditional write on the claim. After `completeStuckDecision`, the original writer may still finish; its write has the
 *    same intent, so it cannot conflict, but it can add a duplicate event. There is no lease: a slow decision cannot be
 *    told from a dead one, which is why completion is an explicit operator action and not an automatic job.
 *  - Approvals of Authority are PER ACTION while decisions here are PER INTERRUPTION. Two interruptions for the same action
 *    can be decided differently by two reviewers (one rejects, one approves): the action then stays authorized. This is a
 *    human decision, not a bypass, and it is not prevented here.
 *  - No exactly-once guarantee. Authority bounds authorization (one redemption per ticket); only the target can
 *    deduplicate or confirm an effect.
 */
import { randomUUID } from "node:crypto";
import { Runner, RunState, type Agent, type RunResult, type RunToolApprovalItem } from "@openai/agents";
import type { Authority, ToolCall } from "authority-graph-sdk";
import type { ActionSummary, InterruptionBinding } from "./authorityTool.js";
import { AuthorityRejectedError, type ApprovalRecorder } from "./host.js";
import { toolOutputsOf, type ToolOutput } from "./scripted.js";

// ---------------------------------------------------------------------------------------------------------------------
// Records and the store
// ---------------------------------------------------------------------------------------------------------------------

export type ApprovalStatus = "PENDING" | "DECIDING" | "APPROVED" | "REJECTED" | "VOID";
export type RunStatus = "WAITING" | "RESUMING" | "FINISHED" | "FAILED";
export type DecisionIntent = "approve" | "reject";

/** What the coordinator keeps for one interruption. The call is the SERVER's copy, built from the validated arguments. */
export interface ApprovalRecord {
  readonly approvalId: string;
  readonly runId: string;
  /** The Agents SDK's tool-call id of this interruption. */
  readonly callId: string;
  readonly actionId: string;
  readonly call: ToolCall;
  readonly summary: ActionSummary;
  readonly status: ApprovalStatus;
  /** Set while `DECIDING` and kept after: who decided, and what they decided. */
  readonly decidedBy?: string;
  readonly intent?: DecisionIntent;
  /** Present only while `DECIDING`: the owner of the claim. Every transition out of `DECIDING` must present it. */
  readonly claimToken?: string;
  /** Present only while `DECIDING`: how many events the Authority journal held when the decision was claimed. */
  readonly claimMark?: number;
  /** Why a decision was not applied (`VOID`). */
  readonly voidReason?: string;
}

export interface RunRecord {
  readonly runId: string;
  /** `RunState.toString()`: sensitive, never sent to a reviewer. */
  readonly snapshot: string;
  readonly approvalIds: readonly string[];
  readonly status: RunStatus;
  /** Present only while `RESUMING`: the owner of this resume. */
  readonly resumeToken?: string;
}

/** `null` clears a field. */
export interface ApprovalPatch {
  decidedBy?: string | null;
  intent?: DecisionIntent | null;
  claimToken?: string | null;
  claimMark?: number | null;
  voidReason?: string;
}

/**
 * The host's store. In a real deployment `transitionApproval` and `transitionRun` are atomic conditional updates in a
 * shared database, and a transition that fails to persist must be visible to the caller (it throws).
 */
export interface ApprovalStore {
  /** Refuses (throws) an id that already exists, for a run or for any of its approvals: nothing is overwritten. */
  putRun(run: RunRecord, approvals: readonly ApprovalRecord[]): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  /**
   * Compare-and-set. Returns false (and changes nothing) when the current status is not one of `from`, or when
   * `expectClaimToken` is given and is not the record's current claim token.
   */
  transitionApproval(approvalId: string, from: readonly ApprovalStatus[], to: ApprovalStatus, patch?: ApprovalPatch, expectClaimToken?: string): Promise<boolean>;
  /** Compare-and-set on a run. `expectToken` must match the current resume token; `setToken` replaces it (`null` clears). */
  transitionRun(runId: string, from: readonly RunStatus[], to: RunStatus, options?: { expectToken?: string; setToken?: string | null }): Promise<boolean>;
  /** Approvals stuck in `DECIDING`, and runs stuck in `RESUMING`: for an operator, never released automatically. */
  listDeciding(): Promise<ApprovalRecord[]>;
  listResuming(): Promise<RunRecord[]>;
}

function applyPatch<T extends object>(current: T, patch: Record<string, string | number | null | undefined>): T {
  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return next as T;
}

/**
 * IN-MEMORY, for the example and its tests only. Each transition checks and writes without an `await` in between, so
 * it is atomic within ONE event loop. It is not safe across processes, it is lost on restart (unless you export it,
 * which the restart tests do), and it must not be presented as a solution for production.
 */
export class InMemoryApprovalStore implements ApprovalStore {
  private runs = new Map<string, RunRecord>();
  private approvals = new Map<string, ApprovalRecord>();

  async putRun(run: RunRecord, approvals: readonly ApprovalRecord[]): Promise<void> {
    if (this.runs.has(run.runId)) throw new Error(`duplicate run id: ${run.runId}`);
    const seen = new Set<string>();
    for (const approval of approvals) {
      if (this.approvals.has(approval.approvalId) || seen.has(approval.approvalId)) throw new Error(`duplicate approval id: ${approval.approvalId}`);
      seen.add(approval.approvalId);
    }
    this.runs.set(run.runId, run);
    for (const approval of approvals) this.approvals.set(approval.approvalId, approval);
  }
  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }
  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    return this.approvals.get(approvalId);
  }
  async transitionApproval(approvalId: string, from: readonly ApprovalStatus[], to: ApprovalStatus, patch: ApprovalPatch = {}, expectClaimToken?: string): Promise<boolean> {
    const current = this.approvals.get(approvalId);
    if (!current || !from.includes(current.status)) return false;
    if (expectClaimToken !== undefined && current.claimToken !== expectClaimToken) return false;
    this.approvals.set(approvalId, applyPatch({ ...current, status: to }, patch as Record<string, string | number | null | undefined>));
    return true;
  }
  async transitionRun(runId: string, from: readonly RunStatus[], to: RunStatus, options: { expectToken?: string; setToken?: string | null } = {}): Promise<boolean> {
    const current = this.runs.get(runId);
    if (!current || !from.includes(current.status)) return false;
    if (options.expectToken !== undefined && current.resumeToken !== options.expectToken) return false;
    this.runs.set(runId, applyPatch({ ...current, status: to }, { resumeToken: options.setToken === undefined ? current.resumeToken ?? null : options.setToken }));
    return true;
  }
  async listDeciding(): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()].filter((a) => a.status === "DECIDING");
  }
  async listResuming(): Promise<RunRecord[]> {
    return [...this.runs.values()].filter((r) => r.status === "RESUMING");
  }

  /** Simulates a process restart in the tests: what a durable store would still hold. */
  export(): string {
    return JSON.stringify({ runs: [...this.runs.values()], approvals: [...this.approvals.values()] });
  }
  static restore(text: string): InMemoryApprovalStore {
    const data = JSON.parse(text) as { runs: RunRecord[]; approvals: ApprovalRecord[] };
    const store = new InMemoryApprovalStore();
    for (const run of data.runs) store.runs.set(run.runId, run);
    for (const approval of data.approvals) store.approvals.set(approval.approvalId, approval);
    return store;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The reviewer's identity: SIMULATED
// ---------------------------------------------------------------------------------------------------------------------

/** Turns whatever the application receives from a reviewer into an authenticated principal, or nothing. */
export interface ReviewerAuthenticator {
  authenticate(credential: unknown): Promise<{ readonly principalId: string } | undefined>;
}

/**
 * SIMULATED token authentication, NOT FOR PRODUCTION: a token is a key in a plain object. There is no expiry, no
 * signature, no revocation, no rate limit, no transport security. A real application uses its own session and identity
 * layer and takes the reviewer from the authenticated request, never from the request body.
 */
export class SimulatedTokenAuthenticator implements ReviewerAuthenticator {
  constructor(private readonly principalByToken: Readonly<Record<string, string>>) {}
  async authenticate(credential: unknown): Promise<{ readonly principalId: string } | undefined> {
    if (typeof credential !== "string" || !Object.prototype.hasOwnProperty.call(this.principalByToken, credential)) return undefined;
    return { principalId: this.principalByToken[credential]! };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The coordinator
// ---------------------------------------------------------------------------------------------------------------------

/** What a reviewer's interface may show: no snapshot, nothing beyond the validated summary. */
export interface PendingApprovalView {
  readonly approvalId: string;
  readonly runId: string;
  readonly callId: string;
  readonly summary: ActionSummary;
}

export type RunOutcome =
  | { readonly status: "WAITING"; readonly runId: string; readonly approvals: readonly PendingApprovalView[] }
  | { readonly status: "DONE"; readonly finalOutput: string | undefined; readonly toolResults: readonly ToolOutput[] }
  /** The resume raised an error, or was superseded. The effect MAY have run: never assume it did not. `retryResume` is safe (see README). */
  | { readonly status: "FAILED"; readonly runId: string; readonly errorName: string }
  | { readonly status: "REFUSED"; readonly reason: "UNKNOWN_RUN" | "NOT_RESUMABLE" | "DECISIONS_PENDING" };

export type DecisionOutcome =
  | { readonly status: "DECIDED"; readonly decision: DecisionIntent }
  | {
      readonly status: "REFUSED";
      readonly reason:
        | "NOT_AUTHENTICATED"
        | "INVALID_DECISION"
        | "UNKNOWN_APPROVAL"
        | "NOT_AUTHORIZED_FOR_THIS_APPROVAL"
        | "ALREADY_DECIDED"
        | "NO_LONGER_WAITING"
        | "ALREADY_AUTHORIZED"
        | "NOT_ACCEPTED_BY_AUTHORITY"
        | "UNAVAILABLE"
        /** An Authority write was attempted and its outcome is not known: the approval is held `DECIDING` for the same intent. */
        | "DECISION_UNCERTAIN"
        /** The decision is in Authority's journal but could not be persisted: held `DECIDING`. */
        | "PERSISTENCE_FAILED"
        | "NOT_STUCK";
      readonly detail?: string;
    };

export type RunRecoveryOutcome = { readonly status: "RECOVERED" } | { readonly status: "NOT_STUCK" };

export interface ApprovalCoordinatorConfig {
  readonly authority: Authority;
  readonly recorder: ApprovalRecorder;
  readonly describeInterruption: (interruption: RunToolApprovalItem) => InterruptionBinding | undefined;
  readonly store: ApprovalStore;
  readonly authenticator: ReviewerAuthenticator;
  /**
   * The HOST decides who may decide THIS approval (for example: only the grantor of the delegation). Checked after
   * authentication and before anything is claimed or written, and again when a stuck decision is completed.
   * Authority still checks the approver independently.
   */
  readonly authorizeReviewer: (principalId: string, record: ApprovalRecord) => Promise<boolean>;
  /** Rebuilds the SAME agent graph (same tools) for a resume, possibly in another process. */
  readonly agentFactory: () => Agent<any, any>;
  readonly runner?: Runner;
  /** Ids for runs and approvals. Default: unguessable and unique across restarts. Inject a deterministic one only in a demo or a test. */
  readonly newId?: (prefix: "run" | "appr") => string;
}

const MESSAGES = {
  unknownTool: "This request could not be matched to an order that can be approved, so it was not placed.",
  noLongerWaiting: "The order is no longer waiting for approval, so it was not placed. Ask again if it is still needed.",
  rejected: "A human rejected this order. It was not placed.",
  inconsistent: "The approved request no longer matches what was approved, so the order was not placed.",
} as const;

type RunResultLike = RunResult<any, any>;

export class ApprovalCoordinator {
  private readonly runner: Runner;

  constructor(private readonly config: ApprovalCoordinatorConfig) {
    this.runner = config.runner ?? new Runner({ tracingDisabled: true });
  }

  private newId(prefix: "run" | "appr"): string {
    return this.config.newId ? this.config.newId(prefix) : `${prefix}-${randomUUID()}`;
  }

  /** Runs the agent. If the run pauses, the interruptions are bound to Authority actions and parked. */
  async start(agent: Agent<any, any>, input: string): Promise<RunOutcome> {
    return this.afterRun(await this.runner.run(agent, input));
  }

  /**
   * One server-side record per interruption. An interruption that cannot be bound to an Authority action that is
   * really waiting for a human is REJECTED at once (fail closed); the model is told so. The store refuses an id that
   * already exists, so a repeated id is an error and never an overwrite.
   */
  private async afterRun(result: RunResultLike): Promise<RunOutcome> {
    const interruptions = result.interruptions ?? [];
    if (interruptions.length === 0) {
      return { status: "DONE", finalOutput: typeof result.finalOutput === "string" ? result.finalOutput : undefined, toolResults: toolOutputsOf(result) };
    }

    const runId = this.newId("run");
    const records: ApprovalRecord[] = [];
    for (const interruption of interruptions) {
      const binding = this.config.describeInterruption(interruption);
      if (!binding) {
        result.state.reject(interruption, { message: MESSAGES.unknownTool });
        continue;
      }
      // The interruption exists because needsApproval said so; make sure Authority still says that now, for these arguments.
      if ((await this.config.authority.authorize(binding.call)).status !== "REQUIRES_APPROVAL") {
        result.state.reject(interruption, { message: MESSAGES.noLongerWaiting });
        continue;
      }
      records.push({ approvalId: this.newId("appr"), runId, callId: binding.callId, actionId: binding.actionId, call: binding.call, summary: binding.summary, status: "PENDING" });
    }
    await this.config.store.putRun({ runId, snapshot: result.state.toString(), approvalIds: records.map((r) => r.approvalId), status: "WAITING" }, records);
    // Nothing for a human to decide (every interruption was rejected above): deliver the rejections to the model now.
    if (records.length === 0) return this.resumeFrom(runId, ["WAITING"]);
    return { status: "WAITING", runId, approvals: records.map(({ approvalId, runId: r, callId, summary }) => ({ approvalId, runId: r, callId, summary })) };
  }

  /**
   * A reviewer decides. Order matters: authenticate FIRST (an unauthenticated caller learns nothing about which ids
   * exist), validate the decision, look the approval up, authorize the reviewer for it, claim it with a token that records
   * the intent, then apply the intent.
   */
  async decide(input: { readonly approvalId: string; readonly decision: DecisionIntent; readonly credential: unknown }): Promise<DecisionOutcome> {
    const { store } = this.config;
    const reviewer = await this.config.authenticator.authenticate(input.credential);
    if (!reviewer) return { status: "REFUSED", reason: "NOT_AUTHENTICATED" };
    // Untrusted input: the type is a compile-time promise only. Anything but the two exact values is refused before any claim.
    if (input.decision !== "approve" && input.decision !== "reject") return { status: "REFUSED", reason: "INVALID_DECISION" };
    const record = typeof input.approvalId === "string" ? await store.getApproval(input.approvalId) : undefined;
    if (!record) return { status: "REFUSED", reason: "UNKNOWN_APPROVAL" };
    if (!(await this.config.authorizeReviewer(reviewer.principalId, record))) return { status: "REFUSED", reason: "NOT_AUTHORIZED_FOR_THIS_APPROVAL" };

    let claimMark: number;
    try {
      claimMark = (await this.config.authority.events()).length;
    } catch {
      return { status: "REFUSED", reason: "UNAVAILABLE" }; // nothing claimed yet
    }
    const claimToken = randomUUID();
    if (!(await store.transitionApproval(record.approvalId, ["PENDING"], "DECIDING", { decidedBy: reviewer.principalId, intent: input.decision, claimToken, claimMark }))) {
      return { status: "REFUSED", reason: "ALREADY_DECIDED" };
    }
    return this.applyIntent(record, input.decision, claimToken, reviewer.principalId);
  }

  /**
   * Applies the claimed INTENT. Before any Authority write is attempted, a failure releases the claim (nothing was decided).
   * After an attempt, a refusal by Authority releases it too (nothing was recorded); an unknown outcome does NOT: the
   * approval stays `DECIDING` with its intent, and only `completeStuckDecision` can move it, with the same intent.
   */
  private async applyIntent(record: ApprovalRecord, intent: DecisionIntent, claimToken: string, reviewer: string): Promise<DecisionOutcome> {
    const { store, authority, recorder } = this.config;
    const release = () => store.transitionApproval(record.approvalId, ["DECIDING"], "PENDING", { decidedBy: null, intent: null, claimToken: null, claimMark: null }, claimToken).catch(() => false);

    let target: "APPROVED" | "REJECTED";
    let current: Awaited<ReturnType<Authority["authorize"]>>;
    try {
      // Binding: the SERVER's copy of the call must still be the action that is waiting for a human.
      current = await authority.authorize(record.call);
    } catch {
      await release();
      return { status: "REFUSED", reason: "UNAVAILABLE" };
    }
    if (current.status === "UNAVAILABLE") {
      await release(); // a transient outage is not a refusal: the reviewer's decision is not lost
      return { status: "REFUSED", reason: "UNAVAILABLE" };
    }
    if (current.status === "AUTHORIZED" && intent === "reject") {
      await release(); // an approval already exists in Authority: a refusal here would not revoke it, so it is not accepted
      return { status: "REFUSED", reason: "ALREADY_AUTHORIZED" };
    }
    if (current.status === "AUTHORIZED") {
      // Authority already holds an approval for exactly this call (an earlier attempt of this decision, or one recorded by the grantor).
      target = "APPROVED";
    } else if (current.status !== "REQUIRES_APPROVAL") {
      const detail = current.reason; // DENIED or UNKNOWN: a definite answer, not a transient failure
      await store.transitionApproval(record.approvalId, ["DECIDING"], "VOID", { voidReason: detail, claimToken: null, claimMark: null }, claimToken).catch(() => false);
      return { status: "REFUSED", reason: "NO_LONGER_WAITING", detail };
    } else {
      try {
        if (intent === "approve") await recorder.approve(record.actionId, reviewer);
        else await recorder.deny(record.actionId, reviewer);
      } catch (error) {
        if (error instanceof AuthorityRejectedError) {
          await release(); // Authority explicitly refused: nothing was decided
          return { status: "REFUSED", reason: "NOT_ACCEPTED_BY_AUTHORITY", detail: error.rejected.join(",") };
        }
        // The write may or may not have reached the journal. Do NOT release: a different decision could then follow it.
        return { status: "REFUSED", reason: "DECISION_UNCERTAIN" };
      }
      target = intent === "approve" ? "APPROVED" : "REJECTED";
    }

    let persisted = false;
    try {
      persisted = await store.transitionApproval(record.approvalId, ["DECIDING"], target, { claimToken: null, claimMark: null }, claimToken);
    } catch {
      persisted = false;
    }
    return persisted ? { status: "DECIDED", decision: intent } : { status: "REFUSED", reason: "PERSISTENCE_FAILED" };
  }

  /** Approvals held `DECIDING`: for an operator. Nothing here is ever released automatically. */
  async listStuckDecisions(): Promise<readonly ApprovalRecord[]> {
    return this.config.store.listDeciding();
  }

  /**
   * EXPLICIT OPERATOR ACTION. Completes a decision that was claimed and never finished, with the SAME intent and the SAME
   * reviewer that the claim recorded. It never opens the approval to a different decision. It re-checks that the reviewer
   * is still authorized and that Authority still binds the same call, takes the claim over with a new token (so the
   * original finisher can no longer move the record), and applies the intent again.
   *
   * It cannot cancel an Authority write that is already in flight: the original writer may still land a duplicate of the
   * same intent. Without a lease, a slow decision cannot be told from a dead one; call this only after deciding, outside
   * this prototype, that the original is gone.
   */
  async completeStuckDecision(approvalId: string): Promise<DecisionOutcome> {
    const { store } = this.config;
    const record = await store.getApproval(approvalId);
    if (!record || record.status !== "DECIDING" || !record.intent || !record.decidedBy || !record.claimToken) return { status: "REFUSED", reason: "NOT_STUCK" };
    if (!(await this.config.authorizeReviewer(record.decidedBy, record))) return { status: "REFUSED", reason: "NOT_AUTHORIZED_FOR_THIS_APPROVAL" };
    const claimToken = randomUUID();
    if (!(await store.transitionApproval(approvalId, ["DECIDING"], "DECIDING", { claimToken }, record.claimToken))) return { status: "REFUSED", reason: "NOT_STUCK" };
    // A stale intent must not override a NEWER decision for the same action that someone recorded since the claim.
    let conflicting: boolean;
    try {
      conflicting = await this.hasConflictingDecisionSince(record);
    } catch {
      return { status: "REFUSED", reason: "UNAVAILABLE" }; // still held DECIDING, under the operator's new token
    }
    if (conflicting) {
      await store.transitionApproval(approvalId, ["DECIDING"], "VOID", { voidReason: "SUPERSEDED", claimToken: null, claimMark: null }, claimToken).catch(() => false);
      return { status: "REFUSED", reason: "NO_LONGER_WAITING", detail: "SUPERSEDED" };
    }
    return this.applyIntent(record, record.intent, claimToken, record.decidedBy);
  }

  /**
   * Is there, in the Authority journal and AFTER this decision was claimed, a decision for the same action that contradicts
   * the intent (a refusal next to an approval, or an approval next to a refusal)? Same-intent events are expected: they are
   * the original writer's own write, landing late. This narrows the staleness window of a completion; it cannot close the
   * window between this read and the write that follows.
   */
  private async hasConflictingDecisionSince(record: ApprovalRecord): Promise<boolean> {
    const events = (await this.config.authority.events()) as unknown as readonly { event_type: string; payload: { action_id?: string } }[];
    const contradicting = record.intent === "approve" ? "APPROVAL_DENIED" : "APPROVAL_GRANTED";
    return events.slice(record.claimMark ?? 0).some((e) => e.event_type === contradicting && e.payload.action_id === record.actionId);
  }

  /** Runs held `RESUMING` (a resume that never finished): for an operator. */
  async listStuckRuns(): Promise<readonly RunRecord[]> {
    return this.config.store.listResuming();
  }

  /**
   * EXPLICIT OPERATOR ACTION. Marks a run stuck in `RESUMING` as `FAILED`, which is what a failed resume already is: the
   * effect MAY have run, and nothing here assumes it did not. The retry goes through `guard()` again, which refuses a second
   * execution of an action that already ran. The original resume, if it is still alive, can no longer finish the run
   * (its token no longer matches) and returns `FAILED`.
   */
  async recoverStuckRun(runId: string): Promise<RunRecoveryOutcome> {
    return (await this.config.store.transitionRun(runId, ["RESUMING"], "FAILED", { setToken: null })) ? { status: "RECOVERED" } : { status: "NOT_STUCK" };
  }

  /** Resumes a parked run once every approval of it is decided. One resume at a time (compare-and-set). */
  async resume(runId: string): Promise<RunOutcome> {
    return this.resumeFrom(runId, ["WAITING"]);
  }

  /** After a FAILED resume. The effect may already have run; Authority refuses a second execution of an approved call. */
  async retryResume(runId: string): Promise<RunOutcome> {
    return this.resumeFrom(runId, ["FAILED"]);
  }

  private async resumeFrom(runId: string, from: readonly RunStatus[]): Promise<RunOutcome> {
    const { store } = this.config;
    const run = await store.getRun(runId);
    if (!run) return { status: "REFUSED", reason: "UNKNOWN_RUN" };
    const approvals = (await Promise.all(run.approvalIds.map((id) => store.getApproval(id)))).filter((a): a is ApprovalRecord => a !== undefined);
    if (approvals.some((a) => a.status === "PENDING" || a.status === "DECIDING")) return { status: "REFUSED", reason: "DECISIONS_PENDING" };
    const token = randomUUID();
    if (!(await store.transitionRun(runId, from, "RESUMING", { setToken: token }))) return { status: "REFUSED", reason: "NOT_RESUMABLE" };

    try {
      const agent = this.config.agentFactory();
      const state = await RunState.fromString(agent, run.snapshot);
      const byCall = new Map(approvals.map((a) => [a.callId, a]));
      for (const interruption of state.getInterruptions()) {
        const binding = this.config.describeInterruption(interruption);
        const record = binding ? byCall.get(binding.callId) : undefined;
        // The snapshot is re-read, so it is re-checked against the server's own record of what was approved.
        if (!binding) {
          state.reject(interruption, { message: MESSAGES.unknownTool }); // not an order this coordinator can approve
        } else if (!record) {
          state.reject(interruption, { message: MESSAGES.noLongerWaiting }); // it was already rejected when the run was parked
        } else if (record.actionId !== binding.actionId || JSON.stringify(record.call) !== JSON.stringify(binding.call)) {
          state.reject(interruption, { message: MESSAGES.inconsistent }); // the snapshot no longer matches what was approved
        } else if (record.status === "APPROVED") {
          state.approve(interruption); // never { alwaysApprove: true }: a sticky approval would skip the human next time
        } else {
          state.reject(interruption, { message: record.status === "REJECTED" ? MESSAGES.rejected : MESSAGES.noLongerWaiting });
        }
      }
      const result = await this.runner.run(agent, state);
      // Only the owner of this resume may finish the run. If an operator recovered it meanwhile, this result is not used.
      if (!(await store.transitionRun(runId, ["RESUMING"], "FINISHED", { expectToken: token, setToken: null }))) return { status: "FAILED", runId, errorName: "ResumeSuperseded" };
      return await this.afterRun(result);
    } catch (error) {
      // The effect may have run before the error (for example a failure of the next model call): do not assume otherwise.
      await store.transitionRun(runId, ["RESUMING"], "FAILED", { expectToken: token, setToken: null }).catch(() => false);
      return { status: "FAILED", runId, errorName: error instanceof Error ? error.name : "Error" };
    }
  }
}
