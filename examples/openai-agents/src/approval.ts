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
 *  - The reviewer's DECISION is recorded in Authority and CHECKED (`outcomes[].accepted`). Authority itself accepts an
 *    approval only from the grantor of the action's delegation; an authenticated reviewer who is not the grantor is
 *    refused by Authority, not by this file.
 *  - The coordinator takes nothing from the reviewer but an approval id, a decision and a credential: the arguments, the
 *    action id, the call id and the snapshot come from its own store.
 *  - No exactly-once guarantee. Authority bounds authorization (one redemption per ticket); only the target can
 *    deduplicate or confirm an effect.
 */
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
  readonly decidedBy?: string;
  /** Why a decision was not applied (`VOID`). */
  readonly voidReason?: string;
}

export interface RunRecord {
  readonly runId: string;
  /** `RunState.toString()`: sensitive, never sent to a reviewer. */
  readonly snapshot: string;
  readonly approvalIds: readonly string[];
  readonly status: RunStatus;
}

/**
 * The host's store. In a real deployment `transitionApproval` and `transitionRun` are atomic conditional updates in a
 * shared database, and a transition that fails to persist must be visible to the caller (it throws).
 */
export interface ApprovalStore {
  putRun(run: RunRecord, approvals: readonly ApprovalRecord[]): Promise<void>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  getApproval(approvalId: string): Promise<ApprovalRecord | undefined>;
  /** Compare-and-set. Returns false (and changes nothing) when the current status is not one of `from`. */
  transitionApproval(approvalId: string, from: readonly ApprovalStatus[], to: ApprovalStatus, patch?: { decidedBy?: string; voidReason?: string }): Promise<boolean>;
  transitionRun(runId: string, from: readonly RunStatus[], to: RunStatus): Promise<boolean>;
  /** Approvals stuck in `DECIDING` (a decision that was claimed and never finished). */
  listDeciding(): Promise<ApprovalRecord[]>;
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
    this.runs.set(run.runId, run);
    for (const approval of approvals) this.approvals.set(approval.approvalId, approval);
  }
  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.runs.get(runId);
  }
  async getApproval(approvalId: string): Promise<ApprovalRecord | undefined> {
    return this.approvals.get(approvalId);
  }
  async transitionApproval(approvalId: string, from: readonly ApprovalStatus[], to: ApprovalStatus, patch: { decidedBy?: string; voidReason?: string } = {}): Promise<boolean> {
    const current = this.approvals.get(approvalId);
    if (!current || !from.includes(current.status)) return false;
    this.approvals.set(approvalId, { ...current, ...patch, status: to });
    return true;
  }
  async transitionRun(runId: string, from: readonly RunStatus[], to: RunStatus): Promise<boolean> {
    const current = this.runs.get(runId);
    if (!current || !from.includes(current.status)) return false;
    this.runs.set(runId, { ...current, status: to });
    return true;
  }
  async listDeciding(): Promise<ApprovalRecord[]> {
    return [...this.approvals.values()].filter((a) => a.status === "DECIDING");
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
  /** The resume raised an error. The effect MAY have run: do not assume it did not. `retryResume` is safe (see README). */
  | { readonly status: "FAILED"; readonly runId: string; readonly errorName: string }
  | { readonly status: "REFUSED"; readonly reason: "UNKNOWN_RUN" | "NOT_RESUMABLE" | "DECISIONS_PENDING" };

export type DecisionOutcome =
  | { readonly status: "DECIDED"; readonly decision: "approve" | "reject" }
  | {
      readonly status: "REFUSED";
      readonly reason: "UNKNOWN_APPROVAL" | "NOT_AUTHENTICATED" | "ALREADY_DECIDED" | "NO_LONGER_WAITING" | "NOT_ACCEPTED_BY_AUTHORITY" | "UNAVAILABLE" | "PERSISTENCE_FAILED";
      readonly detail?: string;
    };

export interface ApprovalCoordinatorConfig {
  readonly authority: Authority;
  readonly recorder: ApprovalRecorder;
  readonly describeInterruption: (interruption: RunToolApprovalItem) => InterruptionBinding | undefined;
  readonly store: ApprovalStore;
  readonly authenticator: ReviewerAuthenticator;
  /** Rebuilds the SAME agent graph (same tools) for a resume, possibly in another process. */
  readonly agentFactory: () => Agent<any, any>;
  readonly runner?: Runner;
  /** Deterministic ids for the demo and the tests. */
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
  private counters = { run: 0, appr: 0 };

  constructor(private readonly config: ApprovalCoordinatorConfig) {
    this.runner = config.runner ?? new Runner({ tracingDisabled: true });
  }

  private newId(prefix: "run" | "appr"): string {
    return this.config.newId ? this.config.newId(prefix) : `${prefix}-${++this.counters[prefix]}`;
  }

  /** Runs the agent. If the run pauses, the interruptions are bound to Authority actions and parked. */
  async start(agent: Agent<any, any>, input: string): Promise<RunOutcome> {
    return this.afterRun(await this.runner.run(agent, input));
  }

  /**
   * One server-side record per interruption. An interruption that cannot be bound to an Authority action that is
   * really waiting for a human is REJECTED at once (fail closed); the model is told so.
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
   * A reviewer decides. Order matters: authenticate, claim (one decision only), check the binding against Authority,
   * write to Authority and CHECK the outcome, and only then persist the decision.
   */
  async decide(input: { readonly approvalId: string; readonly decision: "approve" | "reject"; readonly credential: unknown }): Promise<DecisionOutcome> {
    const { store, authority, recorder } = this.config;
    const record = await store.getApproval(input.approvalId);
    if (!record) return { status: "REFUSED", reason: "UNKNOWN_APPROVAL" };
    const reviewer = await this.config.authenticator.authenticate(input.credential);
    if (!reviewer) return { status: "REFUSED", reason: "NOT_AUTHENTICATED" };

    if (!(await store.transitionApproval(record.approvalId, ["PENDING"], "DECIDING", { decidedBy: reviewer.principalId }))) {
      return { status: "REFUSED", reason: "ALREADY_DECIDED" };
    }

    let target: "APPROVED" | "REJECTED";
    try {
      // Binding: the SERVER's copy of the call must still be the action that is waiting for a human.
      const current = await authority.authorize(record.call);
      if (current.status === "AUTHORIZED" && input.decision === "approve") {
        // Authority already holds an approval for exactly this call (a previous attempt of this decision whose persistence
        // failed, or one recorded elsewhere by the grantor). The reviewer's intent is the same: nothing more to write.
        target = "APPROVED";
      } else if (current.status !== "REQUIRES_APPROVAL") {
        // Revoked, denied, unavailable, or already authorized while the reviewer wants to reject: the decision is not applied.
        const detail = current.status === "DENIED" || current.status === "UNKNOWN" ? current.reason : current.status;
        await store.transitionApproval(record.approvalId, ["DECIDING"], "VOID", { voidReason: detail });
        return { status: "REFUSED", reason: "NO_LONGER_WAITING", detail };
      } else {
        if (input.decision === "approve") await recorder.approve(record.actionId, reviewer.principalId);
        else await recorder.deny(record.actionId, reviewer.principalId);
        target = input.decision === "approve" ? "APPROVED" : "REJECTED";
      }
    } catch (error) {
      // Authority did not take the decision into account (or its answer was lost: a repeated approval is harmless).
      // Release the claim so that a reviewer can try again. If even that fails, the claim stays `DECIDING`.
      await store.transitionApproval(record.approvalId, ["DECIDING"], "PENDING").catch(() => false);
      if (error instanceof AuthorityRejectedError) return { status: "REFUSED", reason: "NOT_ACCEPTED_BY_AUTHORITY", detail: error.rejected.join(",") };
      return { status: "REFUSED", reason: "UNAVAILABLE" };
    }

    // The decision is in Authority's journal. If it cannot be persisted, the approval stays DECIDING: nothing is
    // resumed from it, and `recoverStuckDecisions` releases it for a new decision (a repeated approval is harmless).
    let persisted = false;
    try {
      persisted = await store.transitionApproval(record.approvalId, ["DECIDING"], target);
    } catch {
      persisted = false;
    }
    return persisted ? { status: "DECIDED", decision: input.decision } : { status: "REFUSED", reason: "PERSISTENCE_FAILED" };
  }

  /** Releases decisions that were claimed and never finished. For a startup or a timeout job; a real store needs leases. */
  async recoverStuckDecisions(): Promise<number> {
    let released = 0;
    for (const record of await this.config.store.listDeciding()) {
      if (await this.config.store.transitionApproval(record.approvalId, ["DECIDING"], "PENDING")) released++;
    }
    return released;
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
    if (!(await store.transitionRun(runId, from, "RESUMING"))) return { status: "REFUSED", reason: "NOT_RESUMABLE" };

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
      await store.transitionRun(runId, ["RESUMING"], "FINISHED");
      return await this.afterRun(result);
    } catch (error) {
      // The effect may have run before the error (for example a failure of the next model call): do not assume otherwise.
      await store.transitionRun(runId, ["RESUMING"], "FAILED").catch(() => false);
      return { status: "FAILED", runId, errorName: error instanceof Error ? error.name : "Error" };
    }
  }
}
