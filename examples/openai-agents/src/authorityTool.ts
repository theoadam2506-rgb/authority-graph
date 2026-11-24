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
 *  - No native human approval. The tool does not set `needsApproval`, so the run never pauses and there are no
 *    `interruptions`. When Authority says a human must approve, the model is told so and the tool does not
 *    run. Recording the human's decision is the host's job, outside this adapter (architecture B would bridge it).
 *  - No exactly-once guarantee. Authority bounds authorization: one successful redemption per ticket. Only the
 *    target system can deduplicate or confirm an effect.
 *  - No identity verification, and no protection against a model that is persuaded to ask for something else
 *    that is allowed.
 *
 * The SDK it consumes is experimental, not published to npm and not independently reviewed.
 */
import { tool, type FunctionTool } from "@openai/agents";
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

const notExecuted = (reason: string, message = NOT_RUN): ModelFacingResult => ({ status: "NOT_EXECUTED", reason, message });

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

/**
 * A function tool whose effect can only run through `authority.guard()`.
 * A programming error (an action description Authority rejects as malformed, such as a fractional amount) throws
 * before any effect can run; the Agents SDK then gives the model its generic tool-error text. It is not masked here.
 */
export function authorityTool<S extends z.ZodObject>(config: AuthorityToolConfig<S>): AuthorityFunctionTool {
  const { authority, principal, describeAction, effect } = config;
  return tool({
    name: config.name,
    description: config.description,
    // The Agents SDK validates the model's arguments against this schema before `execute` runs.
    parameters: config.parameters as z.ZodObject,
    // Deliberately no `needsApproval`: this is architecture A. The run never pauses.
    execute: async (rawInput: unknown): Promise<string> => {
      const input = rawInput as z.infer<S>;
      const call: ToolCall = { ...describeAction(input), agentId: principal.agentId, delegationId: principal.delegationId };
      const result = await authority.guard(call, (context) => effect(input, context));
      return JSON.stringify(toModelResult(result));
    },
  });
}
