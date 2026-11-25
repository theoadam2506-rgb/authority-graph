/**
 * Architecture A: `authority.guard()` inside the `execute` of an OpenAI Agents SDK function tool.
 *
 * What this adapter does, and nothing more:
 *  - It turns the model's already validated arguments into an Authority `ToolCall`. Two things are different:
 *      - The IDENTITY (`agentId`, `delegationId`) comes from the HOST, given when the tool is built. Nothing the
 *        model writes can change it.
 *      - The BUSINESS REFERENCE that becomes the action id comes, in this example, from the MODEL's arguments (the
 *        host's `describeAction` reads it from the validated input). The schema checks its format, not whether it
 *        is legitimate: see `describeAction` below.
 *  - It runs the external effect only through `authority.guard()`: `authorize`, single-use `redeem`, the
 *    effect, `report`. `guard` never retries the effect.
 *  - It turns every `GuardResult` into a small JSON string for the model, without a raw error and without a
 *    diagnostic id (those belong to the operator, through `onDiagnostic`).
 *
 * What it does NOT do:
 *  - By default (architecture A) no native human approval: the tool does not set `needsApproval`, so the run never
 *    pauses and there are no `interruptions`. When Authority says a human must approve, the model is told so and the
 *    tool does not run. Recording the human's decision is the host's job, outside this adapter.
 *  - With `approval: "authority"` (architecture B, experimental) `needsApproval` is set to ask Authority, and the run
 *    PAUSES with interruptions. That pause is only a user-experience mechanism, NEVER an authorization: `execute`
 *    still goes through `authority.guard()`, so a wrongly approved, sticky-approved or missing SDK approval cannot
 *    make the effect run. The coordinator in `approval.ts` records the human's decision in Authority.
 *  - No exactly-once guarantee. Authority bounds authorization: one successful redemption per ticket. Only the
 *    target system can deduplicate or confirm an effect.
 *  - No identity verification, and no protection against a model that is persuaded to ask for something else
 *    that is allowed.
 *
 * The SDK it consumes is experimental, not published to npm and not independently reviewed.
 */
import { tool, type FunctionTool, type RunToolApprovalItem } from "@openai/agents";
import type { Authority, EffectContext, GuardResult, ToolCall } from "authority-graph-sdk";
import type { z } from "zod";

/** Who is acting. Supplied by the host when the tool is built; the model's arguments can never change it. */
export interface HostPrincipal {
  /** The principal that makes the call, already authenticated by the host. Authority does not verify it. */
  readonly agentId: string;
  /** The delegation that principal invokes. */
  readonly delegationId: string;
}

/** The action Authority evaluates: a `ToolCall` without the identity, which comes from the host. */
export type ActionDescription = Omit<ToolCall, "agentId" | "delegationId">;

export interface AuthorityToolConfig<S extends z.ZodObject> {
  readonly authority: Authority;
  readonly name: string;
  readonly description: string;
  /** The arguments the model may provide. Keys not in this schema are dropped before anything else runs. */
  readonly parameters: S;
  readonly principal: HostPrincipal;
  /**
   * Maps the validated arguments to the action. `actionId` MUST be derived from a stable BUSINESS reference (an
   * order number), never from the model's tool-call id: that id changes every time the model asks again, so the
   * same order would look like a new action. The same `actionId` with different arguments is refused by Authority
   * (`ACTION_ID_REUSED_WITH_DIFFERENT_CALL`).
   *
   * WHERE THE REFERENCE COMES FROM IS THE HOST'S RESPONSIBILITY, AND THIS ADAPTER DOES NOT ENFORCE IT. In the
   * example, `orderRef` is one of the MODEL's arguments: zod validates its format (a non-empty string of at most 64
   * characters), not whether it is legitimate. Nothing here ties it to an order the host recorded, and nothing stops
   * the model from inventing a new reference, which is a new action with a new ticket, to retry an operation whose
   * outcome is uncertain. A real application must bind the reference to an order it registered itself (for example
   * by issuing the reference and checking it here before the call), and must refuse new references for the retry of
   * an operation that may already have happened. The example does NOT provide that protection.
   */
  readonly describeAction: (input: z.infer<S>) => ActionDescription;
  /**
   * The external effect. It runs only after Authority redeemed a single-use ticket. `context.idempotencyKey` is the
   * ticket id: pass it to the target. It identifies THIS attempt; a new action has a new ticket, so a new key.
   * Whatever it returns must be JSON-safe: it is shown to the model.
   */
  readonly effect: (input: z.infer<S>, context: EffectContext) => Promise<unknown>;
  /**
   * Host-side checks that run BEFORE Authority is asked (for example: is this order reference a registered order, and
   * do the arguments match the registration?). A refusal means the tool does not run and Authority is never asked,
   * so nothing is journaled for a reference the host does not know. It runs in `needsApproval` too, so that no human
   * is asked to approve an unregistered order.
   */
  readonly precheck?: (input: z.infer<S>) => Promise<PrecheckResult>;
  /**
   * `"authority"` enables the experimental bridge (architecture B): `needsApproval` asks Authority and pauses the run
   * only when Authority answers `REQUIRES_APPROVAL`. Absent: architecture A, the run never pauses.
   */
  readonly approval?: "authority";
}

/** The answer of a host-side `precheck`. */
export type PrecheckResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** What a human reviewer is shown, built from the validated arguments (never from the model's free text). */
export interface ActionSummary {
  readonly actionId: string;
  readonly amount?: { readonly value: number; readonly currency: string };
  readonly recipient?: string;
  readonly args: unknown;
}

/** An interruption bound to the validated arguments, the Authority action and the SDK's tool-call id. */
export interface InterruptionBinding {
  readonly callId: string;
  readonly actionId: string;
  /** The exact call Authority evaluates for this interruption. */
  readonly call: ToolCall;
  readonly summary: ActionSummary;
}

/** The tool this adapter builds: a function tool with a Zod object schema and a string result. */
export type AuthorityFunctionTool = FunctionTool<unknown, z.ZodObject, string>;

/** What the model is told. Plain data, serialised as JSON in the tool output. */
export type ModelFacingResult =
  /** The effect ran and returned. `recorded` is false when the journal write failed afterwards (the effect still ran). */
  | { readonly status: "EXECUTED"; readonly value: unknown; readonly recorded: boolean }
  /** Authority needs a human decision for this exact action. The tool did not run. */
  | { readonly status: "APPROVAL_REQUIRED"; readonly message: string }
  /** The tool did not run. `reason` is a fixed code chosen by Authority. */
  | { readonly status: "NOT_EXECUTED"; readonly reason: string; readonly message: string }
  /** The effect started and then failed: the target may have completed it. Never "it failed". */
  | { readonly status: "OUTCOME_UNKNOWN"; readonly message: string };

const APPROVAL_MESSAGE =
  "A human must approve this exact order before it can run. Tell the user that it is waiting for approval. " +
  "Do not send it again under another reference: that is a different order.";
const NOT_RUN = "The order was not placed.";
const UNKNOWN_MESSAGE =
  "The call to the supplier failed after it may have been received, so the order may exist. " +
  "Do not assume that it failed, and do not send it again, under this or another reference. " +
  "Ask the user to check with the supplier.";
const REDEMPTION_UNCERTAIN_MESSAGE =
  "The order was not sent to the supplier, and its authorization is in an uncertain state. " +
  "Do not send it again under another reference. Ask the user to have it checked.";

const PRECHECK_MESSAGE =
  "The order was not placed: this reference does not match an order registered by the application. " +
  "Do not invent another reference. Ask the user to register the order.";

const ALREADY_PROCESSED_MESSAGE =
  "This order was already processed by an earlier attempt, so it was not sent again. Do not send it again, under this or " +
  "another reference. Its outcome is in the application's records: ask the user to check it.";

/** Reasons that mean "an earlier attempt already consumed this action": the order may well have been placed. */
const ALREADY_PROCESSED = new Set(["ALREADY_REDEEMED", "C7_APPROVAL_ALREADY_CONSUMED"]);

const notExecuted = (reason: string, message = ALREADY_PROCESSED.has(reason) ? ALREADY_PROCESSED_MESSAGE : NOT_RUN): ModelFacingResult => ({ status: "NOT_EXECUTED", reason, message });

/** Every `GuardResult`, one answer for the model. The switches are exhaustive: a new SDK status fails to compile here. */
export function toModelResult(result: GuardResult<unknown>): ModelFacingResult {
  switch (result.status) {
    case "EXECUTED":
      return { status: "EXECUTED", value: result.value ?? null, recorded: result.report.status === "REPORTED" || result.report.status === "ALREADY_REPORTED" };
    case "EFFECT_FAILED":
      return { status: "OUTCOME_UNKNOWN", message: UNKNOWN_MESSAGE };
    case "BLOCKED": {
      if (result.stage === "authorize") {
        const r = result.result;
        switch (r.status) {
          case "REQUIRES_APPROVAL":
            return { status: "APPROVAL_REQUIRED", message: APPROVAL_MESSAGE };
          case "DENIED":
            return notExecuted(r.reason);
          case "UNKNOWN":
            return notExecuted(`UNKNOWN:${r.reason}`);
          case "UNAVAILABLE":
            return notExecuted(r.code);
          default:
            return assertNever(r);
        }
      }
      const r = result.result;
      switch (r.status) {
        case "REFUSED":
          return notExecuted(r.reason);
        case "UNKNOWN_OUTCOME":
          return notExecuted(r.code, REDEMPTION_UNCERTAIN_MESSAGE);
        case "UNAVAILABLE":
          return notExecuted(r.code);
        default:
          return assertNever(r);
      }
    }
    default:
      return assertNever(result);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Authority result: ${JSON.stringify(value)}`);
}

/** The tool and, for the bridge, the way to bind an SDK interruption to an Authority action. */
export interface AuthorityToolBundle {
  readonly tool: AuthorityFunctionTool;
  /**
   * Re-parses an interruption's arguments with the tool's schema and rebuilds the Authority call from them.
   * `undefined` for another tool, another item type, or arguments the schema rejects: the caller must fail closed.
   */
  describeInterruption(interruption: RunToolApprovalItem): InterruptionBinding | undefined;
}

/**
 * A function tool whose effect can only run through `authority.guard()`.
 * A programming error (an action description Authority rejects as malformed, such as a fractional amount) throws
 * before any effect can run; the Agents SDK then gives the model its generic tool-error text. It is not masked here.
 */
export function authorityTool<S extends z.ZodObject>(config: AuthorityToolConfig<S>): AuthorityFunctionTool {
  return buildAuthorityTool(config).tool;
}

export function buildAuthorityTool<S extends z.ZodObject>(config: AuthorityToolConfig<S>): AuthorityToolBundle {
  const { authority, principal, describeAction, effect, precheck } = config;
  const callOf = (input: z.infer<S>): ToolCall => ({ ...describeAction(input), agentId: principal.agentId, delegationId: principal.delegationId });

  const functionTool = tool({
    name: config.name,
    description: config.description,
    // The Agents SDK validates the model's arguments against this schema before `execute` runs.
    parameters: config.parameters as z.ZodObject,
    // Architecture B only. This is a PAUSE, not a permission: execute below always goes through guard().
    ...(config.approval === "authority"
      ? {
          needsApproval: async (_context: unknown, rawInput: unknown): Promise<boolean> => {
            const input = rawInput as z.infer<S>;
            try {
              if (precheck && !(await precheck(input)).ok) return false; // execute refuses it; no human is asked
              return (await authority.authorize(callOf(input))).status === "REQUIRES_APPROVAL";
            } catch {
              return false; // fail closed: execute re-asks Authority through guard() and refuses or throws there
            }
          },
        }
      : {}),
    execute: async (rawInput: unknown): Promise<string> => {
      const input = rawInput as z.infer<S>;
      if (precheck) {
        const checked = await precheck(input);
        if (!checked.ok) return JSON.stringify(notExecuted(checked.reason, PRECHECK_MESSAGE));
      }
      const result = await authority.guard(callOf(input), (context) => effect(input, context));
      return JSON.stringify(toModelResult(result));
    },
  });

  return {
    tool: functionTool as AuthorityFunctionTool,
    describeInterruption(interruption) {
      const raw = interruption.rawItem;
      if (raw.type !== "function_call" || raw.name !== config.name) return undefined;
      let json: unknown;
      try {
        json = JSON.parse(raw.arguments);
      } catch {
        return undefined;
      }
      const parsed = config.parameters.safeParse(json);
      if (!parsed.success) return undefined;
      const call = callOf(parsed.data as z.infer<S>);
      return { callId: raw.callId, actionId: call.actionId, call, summary: { actionId: call.actionId, ...(call.amount ? { amount: call.amount } : {}), ...(call.recipient ? { recipient: call.recipient } : {}), args: call.args } };
    },
  };
}
