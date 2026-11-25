/**
 * The "host application" of the example: everything Authority deliberately leaves to the host.
 *  - The clock (a fixed one you control: Authority has no default clock).
 *  - The identity of the agent (`agentId`, `delegationId`) and of the human (asserted here by host code; Authority
 *    verifies neither). This is the part that really comes from the host: the model cannot change it.
 *  - The business reference of each order, which becomes the Authority action id. In THIS example it is NOT issued or
 *    checked by the host: `orderRef` is an argument the MODEL writes, and zod validates only its format. A real host
 *    must bind it to an order it registered and prevent arbitrary new references from being used to retry an
 *    operation whose outcome is uncertain. The example does not do that.
 *  - Recording the human's decision and the revocation (out of band: architecture A has no native pause).
 *  - The delegation: `alice` lets `procurement-agent` create purchase orders, up to 2,000 EUR on its own, up to
 *    5,000 EUR with a human approval, and 5,000 EUR in total.
 */
import { randomUUID } from "node:crypto";
import { createAuthority, createEventBuilders, memoryBackend, type Authority, type Backend, type Diagnostic, type EventBuilders } from "authority-graph-sdk";
import { z } from "zod";
import { buildAuthorityTool, type AuthorityFunctionTool, type AuthorityToolBundle, type HostPrincipal } from "./authorityTool.js";
import { registryPrecheck, type OrderRegistry } from "./orderRegistry.js";
import { SimulatedSupplier } from "./supplier.js";

/** The human who granted the delegation. Only this principal may decide an approval (the host checks it; Authority checks it too). */
export const GRANTOR = "alice";

/** Asserted by the host. The model never provides, and cannot change, either field. */
export const PRINCIPAL: HostPrincipal = { agentId: "procurement-agent", delegationId: "d-1" };

/**
 * The arguments the model may provide. `orderRef` is the business reference that becomes the action id. It is a MODEL
 * argument here: zod checks its format (non-empty, at most 64 characters), not its legitimacy. Nothing ties it to a
 * registered order.
 */
export const orderParameters = z.object({
  orderRef: z.string().min(1).max(64),
  sku: z.string().min(1).max(64),
  qty: z.number().int().positive(),
  amountEur: z.number().int().nonnegative(),
  supplier: z.string().min(1).max(64),
});
export type OrderInput = z.infer<typeof orderParameters>;

/**
 * The Authority action id of an order: derived from the business reference (`orderRef`, a model argument in this
 * example), never from the model's tool-call id. Whoever controls `orderRef` controls which action is evaluated.
 */
export const actionIdOf = (orderRef: string): string => `po:${orderRef}`;

/** A clock you control. */
export class FixedClock {
  private ms = Date.parse("2026-06-01T09:00:00.000Z");
  now(): string {
    return new Date(this.ms).toISOString();
  }
  advance(milliseconds: number): void {
    this.ms += milliseconds;
  }
}

/** Faults that the host's own storage can have: the two ways the outcome can become uncertain (see `SDK.md`). */
export interface HostFaults {
  /** The first redemption is written, then its acknowledgement is lost: the SDK answers `UNKNOWN_OUTCOME`. */
  readonly loseFirstRedemptionAcknowledgement?: boolean;
  /** Writing `ACTION_EXECUTED` fails: the effect ran, the journal does not say so. */
  readonly failToReportExecution?: boolean;
  /** Writing an approval decision fails (the store is unreachable). Mutable on purpose: a test clears it to let a retry through. */
  failToRecordApproval?: boolean;
}

type BackendParts = ReturnType<Backend["build"]>;

function withFaults(backend: Backend, faults: HostFaults): Backend {
  return {
    build(ingestionClock) {
      const parts: BackendParts = backend.build(ingestionClock);
      let redemptions = 0;
      return {
        store: {
          getEvents: (filter) => parts.store.getEvents(filter),
          getBySequence: (range) => parts.store.getBySequence(range),
          append: async (drafts) => {
            if (faults.failToReportExecution && drafts.some((d) => d.event_type === "ACTION_EXECUTED")) throw new Error("journal write failed");
            if (faults.failToRecordApproval && drafts.some((d) => d.event_type === "APPROVAL_GRANTED" || d.event_type === "APPROVAL_DENIED")) throw new Error("journal write failed");
            return parts.store.append(drafts);
          },
        },
        issuance: parts.issuance,
        redemption: {
          redeem: async (...args) => {
            const result = await parts.redemption.redeem(...args);
            if (faults.loseFirstRedemptionAcknowledgement && redemptions++ === 0) throw new Error("connection reset after commit");
            return result;
          },
        },
      };
    },
  };
}

/** Authority refused (some of) what was written: `record()` answers `RECORDED` even when an outcome is not accepted. */
export class AuthorityRejectedError extends Error {
  constructor(readonly rejected: readonly string[]) {
    super(`Authority did not accept: ${rejected.join(", ")}`);
    this.name = "AuthorityRejectedError";
  }
}

/**
 * Writes to the Authority journal and CHECKS the result. `record()` returns `status: "RECORDED"` even when an event is
 * refused (for example `UNAUTHORIZED_APPROVAL_DECISION`): only `outcomes[].accepted` says what was taken into account.
 * Throws `AuthorityRejectedError` when any outcome is not accepted, and a plain Error when the store was unavailable.
 */
export async function recordChecked(authority: Authority, drafts: Parameters<Authority["record"]>[0]): Promise<void> {
  const result = await authority.record(drafts);
  if (result.status !== "RECORDED") throw new Error(`Authority could not record: ${result.code}`);
  const refused = result.outcomes.filter((outcome) => !outcome.accepted).map((outcome) => outcome.detail);
  if (refused.length > 0) throw new AuthorityRejectedError(refused);
}

/** Records a human's decision in Authority. The reviewer identity is whatever the host passes: asserted, not verified. */
export interface ApprovalRecorder {
  /** A human approves this exact action. Throws `AuthorityRejectedError` when Authority does not accept the approver. */
  approve(actionId: string, approver: string): Promise<void>;
  /** A human refuses this action. Journaled; it does not make the action permanently denied (a new request can still be approved). */
  deny(actionId: string, denier: string): Promise<void>;
}

export interface Host {
  readonly clock: FixedClock;
  readonly authority: Authority;
  readonly events: EventBuilders;
  readonly supplier: SimulatedSupplier;
  readonly tool: AuthorityFunctionTool;
  /** Binds an SDK interruption to the Authority action (architecture B). */
  readonly describeInterruption: AuthorityToolBundle["describeInterruption"];
  readonly recorder: ApprovalRecorder;
  /** What reached the OPERATOR (never the model): one entry per failure that Authority diagnosed. */
  readonly diagnostics: Diagnostic[];
  /** The human `alice` approves this exact action. Done by the host, outside the Agents SDK. */
  approve(actionId: string): Promise<void>;
  /** The human `alice` revokes the delegation. */
  revoke(): Promise<void>;
  /** The journal as `EVENT_TYPE` or `EVENT_TYPE(code)` for `ACTION_EXECUTED`. */
  journal(): Promise<string[]>;
}

export interface HostOptions {
  readonly faults?: HostFaults;
  /** Architecture B: the tool pauses the run when Authority needs a human (`needsApproval`). Default: architecture A. */
  readonly approval?: "authority";
  /** Ids of the approval events written to the journal. Default: unique across restarts (`ap-<uuid>`). Inject a deterministic one only in a demo or a test. */
  readonly newApprovalId?: () => string;
  /** The host's own orders. When given, a reference that is not registered, or arguments that differ from it, are refused. */
  readonly registry?: OrderRegistry;
}

export async function createHost(options: HostOptions = {}): Promise<Host> {
  const clock = new FixedClock();
  const events = createEventBuilders({ clock });
  const diagnostics: Diagnostic[] = [];
  const authority = createAuthority({
    backend: withFaults(memoryBackend(), options.faults ?? {}),
    clock,
    enforcementPointId: "supplier-orders-tool",
    onDiagnostic: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  });
  await authority.record([
    events.delegation({
      delegationId: PRINCIPAL.delegationId,
      grantor: GRANTOR,
      grantee: PRINCIPAL.agentId,
      capabilities: [{ resource: "purchase_order", action: "create" }],
      canDelegate: false,
      expiresAt: null,
      thresholds: { automaticMax: { value: 2000, currency: "EUR" }, approvalMax: { value: 5000, currency: "EUR" } },
      totalBudget: { value: 5000, currency: "EUR" },
    }),
  ]);

  const supplier = new SimulatedSupplier();
  const bundle = buildAuthorityTool({
    authority,
    name: "place_supplier_order",
    description: "Place a purchase order with a supplier. orderRef is the order's business reference.",
    parameters: orderParameters,
    principal: PRINCIPAL,
    ...(options.approval ? { approval: options.approval } : {}),
    ...(options.registry ? { precheck: registryPrecheck(options.registry) } : {}),
    describeAction: (order) => ({
      actionId: actionIdOf(order.orderRef),
      capability: { resource: "purchase_order", action: "create" },
      amount: { value: order.amountEur, currency: "EUR" },
      recipient: order.supplier,
      args: { orderRef: order.orderRef, sku: order.sku, qty: order.qty },
    }),
    effect: async (order, context) => {
      const { confirmation } = await supplier.place({ ...order, idempotencyKey: context.idempotencyKey });
      return { confirmation };
    },
  });

  const newApprovalId = options.newApprovalId ?? (() => `ap-${randomUUID()}`);
  const recorder: ApprovalRecorder = {
    async approve(actionId, approver) {
      clock.advance(60_000);
      const approvalId = newApprovalId();
      await recordChecked(authority, [
        events.approvalRequest({ approvalId, actionId, requestedBy: PRINCIPAL.agentId, requestedFrom: GRANTOR, reasonCode: "OVER_AUTOMATIC_LIMIT" }),
        events.approvalGranted({ approvalId, actionId, approver }),
      ]);
    },
    async deny(actionId, denier) {
      clock.advance(60_000);
      const approvalId = newApprovalId();
      await recordChecked(authority, [
        events.approvalRequest({ approvalId, actionId, requestedBy: PRINCIPAL.agentId, requestedFrom: GRANTOR, reasonCode: "OVER_AUTOMATIC_LIMIT" }),
        events.approvalDenied({ approvalId, actionId, denier, reasonCode: "HUMAN_REFUSED" }),
      ]);
    },
  };

  return {
    clock,
    authority,
    events,
    supplier,
    tool: bundle.tool,
    describeInterruption: bundle.describeInterruption,
    recorder,
    diagnostics,
    async approve(actionId) {
      await recorder.approve(actionId, GRANTOR);
    },
    async revoke() {
      clock.advance(60_000);
      await recordChecked(authority, [events.revocation({ delegationId: PRINCIPAL.delegationId, revokedBy: GRANTOR, reasonCode: "OWNER_REQUEST" })]);
    },
    async journal() {
      const all = (await authority.events()) as unknown as { event_type: string; payload: { execution_result?: string } }[];
      return all.map((e) => (e.event_type === "ACTION_EXECUTED" ? `ACTION_EXECUTED(${String(e.payload.execution_result)})` : e.event_type));
    },
  };
}
