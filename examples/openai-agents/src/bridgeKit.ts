/**
 * Everything the architecture B scenarios and tests share: a host with the bridge tool and an order registry, a
 * coordinator with an in-memory store and a SIMULATED token authenticator, and scripted agents.
 *
 * The model is scripted (`ScriptedModel`): no API key, no network call to OpenAI. The "restart" the tests simulate
 * rebuilds the agent graph, the coordinator and the store from exported data, but keeps the same Authority instance:
 * the in-memory journal does not survive a real restart. A real deployment uses the PostgreSQL backend.
 */
import { Agent } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall } from "@openai/agents/testing";
import {
  ApprovalCoordinator,
  InMemoryApprovalStore,
  SimulatedTokenAuthenticator,
  type ApprovalCoordinatorConfig,
  type ApprovalPatch,
  type ApprovalRecord,
  type ApprovalStatus,
  type ApprovalStore,
  type RunRecord,
  type RunStatus,
} from "./approval.js";
import { GRANTOR, createHost, type Host, type HostFaults } from "./host.js";
import { InMemoryOrderRegistry, type RegisteredOrder } from "./orderRegistry.js";
import type { SupplierBehaviour } from "./supplier.js";

/** SIMULATED tokens. `alice` is the delegation's grantor; the other two are authenticated but may not approve. */
export const TOKENS = { "token-alice": "alice", "token-mallory": "mallory", "token-agent": "procurement-agent" } as const;

/** What the model writes for a tool call. The order must have been registered by the host for the call to run. */
export const orderArgs = (order: RegisteredOrder, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ ...order, ...extra });

export const callOrder = (order: RegisteredOrder, callId: string, extra: Record<string, unknown> = {}) => functionCall("place_supplier_order", orderArgs(order, extra), { callId });

/** A registered order of 3,500 EUR (above the 2,000 EUR automatic limit: a human must approve it). */
export const order = (orderRef: string, amountEur = 2400, over: Partial<RegisteredOrder> = {}): RegisteredOrder => ({ orderRef, sku: "A-100", qty: 7, amountEur, supplier: "vendor-1", ...over });

type Steps = readonly unknown[];

/** The exported shape of the in-memory store (runs and approvals), editable in a test. */
export interface StoreExport {
  runs: { runId: string; snapshot: string; approvalIds: string[]; status: string }[];
  approvals: { approvalId: string; status: string; call: { amount?: { value: number } } & Record<string, unknown> }[];
}

/** A store that can be made to fail, to test the windows between an Authority write, the coordinator's persistence and the resume. */
export class FaultyApprovalStore implements ApprovalStore {
  /** Statuses whose transition throws, once each (the transition is NOT applied). */
  failTransitionTo: ApprovalStatus[] = [];
  constructor(private readonly inner: ApprovalStore) {}
  putRun(run: RunRecord, approvals: readonly ApprovalRecord[]) {
    return this.inner.putRun(run, approvals);
  }
  getRun(runId: string) {
    return this.inner.getRun(runId);
  }
  getApproval(approvalId: string) {
    return this.inner.getApproval(approvalId);
  }
  async transitionApproval(approvalId: string, from: readonly ApprovalStatus[], to: ApprovalStatus, patch?: ApprovalPatch, expectClaimToken?: string) {
    const index = this.failTransitionTo.indexOf(to);
    if (index >= 0) {
      this.failTransitionTo.splice(index, 1);
      throw new Error("store unavailable");
    }
    return this.inner.transitionApproval(approvalId, from, to, patch, expectClaimToken);
  }
  transitionRun(runId: string, from: readonly RunStatus[], to: RunStatus, options?: { expectToken?: string; setToken?: string | null }) {
    return this.inner.transitionRun(runId, from, to, options);
  }
  listDeciding() {
    return this.inner.listDeciding();
  }
  listResuming() {
    return this.inner.listResuming();
  }
}

export interface BridgeKit {
  readonly host: Host;
  readonly registry: InMemoryOrderRegistry;
  readonly store: FaultyApprovalStore;
  coordinator: ApprovalCoordinator;
  /** The configuration of the kit's coordinator, to build another one with a changed part (a test of a misconfiguration). */
  coordinatorConfig(overrides?: Partial<ApprovalCoordinatorConfig>): ApprovalCoordinatorConfig;
  /** Registers an order as the HOST would (never the model). */
  register(order: RegisteredOrder): RegisteredOrder;
  /** An agent whose scripted model follows `steps`. */
  agent(steps: Steps): Agent<any, any>;
  /** The scripts the coordinator's `agentFactory` hands out, one per resume, in order. Default after the queue: a final answer. */
  queueResume(...steps: Steps[]): void;
  /**
   * Simulates a restart: rebuilds the store (from its exported data), the coordinator and the factory; keeps the same
   * Authority. `mutate` edits the exported data first, to simulate what a crash left behind or what an attacker changed.
   */
  restart(mutate?: (exported: StoreExport) => void): void;
}

export interface BridgeKitOptions {
  readonly faults?: HostFaults;
  readonly supplier?: SupplierBehaviour;
  /** A MISCONFIGURED host that lets every authenticated reviewer decide: shows that Authority is a second layer. */
  readonly permissiveReviewerCheck?: boolean;
  /** Use the production-style default ids (unique across restarts) instead of the deterministic ones of the demo. */
  readonly randomIds?: boolean;
}

export async function createBridgeKit(options: BridgeKitOptions = {}): Promise<BridgeKit> {
  const registry = new InMemoryOrderRegistry();
  // Deterministic ids for the demo and its pinned output. They live in the KIT, not in a coordinator, so they keep counting across restarts.
  const counters = { run: 0, appr: 0, ap: 0 };
  const host = await createHost({
    approval: "authority",
    registry,
    ...(options.faults ? { faults: options.faults } : {}),
    ...(options.randomIds ? {} : { newApprovalId: () => `ap-${++counters.ap}` }),
  });
  if (options.supplier) host.supplier.behaviour = options.supplier;
  const resumeScripts: Steps[] = [];
  const authenticator = new SimulatedTokenAuthenticator(TOKENS);

  const agentOf = (steps: Steps): Agent<any, any> => new Agent({ name: "buyer", model: new ScriptedModel(steps as never), tools: [host.tool] });
  const configOf = (store: ApprovalStore, overrides: Partial<ApprovalCoordinatorConfig> = {}): ApprovalCoordinatorConfig => ({
    authority: host.authority,
    recorder: host.recorder,
    describeInterruption: host.describeInterruption,
    store,
    authenticator,
    authorizeReviewer: options.permissiveReviewerCheck ? async () => true : async (principalId) => principalId === GRANTOR,
    agentFactory: () => agentOf(resumeScripts.shift() ?? [[assistantMessage("done")]]),
    ...(options.randomIds ? {} : { newId: (prefix: "run" | "appr") => `${prefix}-${++counters[prefix]}` }),
    ...overrides,
  });
  const build = (inner: ApprovalStore): [FaultyApprovalStore, ApprovalCoordinator] => {
    const store = new FaultyApprovalStore(inner);
    return [store, new ApprovalCoordinator(configOf(store))];
  };

  const [store, coordinator] = build(new InMemoryApprovalStore());
  const kit: BridgeKit = {
    host,
    registry,
    store,
    coordinator,
    coordinatorConfig: (overrides) => configOf(kit.store, overrides),
    register(o) {
      registry.register(o);
      return o;
    },
    agent: agentOf,
    queueResume(...steps) {
      resumeScripts.push(...steps);
    },
    restart(mutate) {
      const data = JSON.parse((kit.store as unknown as { inner: InMemoryApprovalStore }).inner.export()) as StoreExport;
      mutate?.(data);
      const [newStore, newCoordinator] = build(InMemoryApprovalStore.restore(JSON.stringify(data)));
      (kit as { store: FaultyApprovalStore }).store = newStore;
      kit.coordinator = newCoordinator;
    },
  };
  return kit;
}
