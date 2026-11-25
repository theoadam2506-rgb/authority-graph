/**
 * Runs the real Agents SDK loop with a SCRIPTED model: the model's tool calls are written here, nothing is sent
 * to OpenAI, no API key is read, tracing is off. What is real is everything after the model: the SDK's tool
 * pipeline, the adapter, Authority and the simulated supplier. What is NOT real is the model: this does not show
 * how a language model behaves, or how it reacts to what it is told.
 */
import { Agent, Runner } from "@openai/agents";
import { ScriptedModel, assistantMessage, functionCall } from "@openai/agents/testing";
import type { ModelFacingResult } from "./authorityTool.js";
import type { Host } from "./host.js";

/** What the model received back from the tool, or the Agents SDK's own text when the tool raised an error. */
export type ToolOutput =
  | ModelFacingResult
  /** The Agents SDK's own generic error text (a tool error or arguments rejected by the schema). */
  | { readonly status: "SDK_TOOL_ERROR"; readonly text: string }
  /** Any other text the SDK gave the model instead of running the tool, such as the message of a rejected approval. */
  | { readonly status: "SDK_MESSAGE"; readonly text: string };

const SDK_GENERIC_ERROR = "An error occurred while running the tool.";

export interface AskOutcome {
  /** One entry per scripted tool call, in order. */
  readonly toolOutputs: ToolOutput[];
  /** How many times the scripted model was called (one per tool call, plus the final answer). */
  readonly modelCalls: number;
}

export function parseToolOutput(raw: unknown): ToolOutput {
  const text = typeof raw === "string" ? raw : ((raw as { text?: unknown } | null)?.text as string | undefined) ?? JSON.stringify(raw);
  try {
    const parsed = JSON.parse(text) as { status?: unknown };
    if (typeof parsed.status === "string") return parsed as ModelFacingResult;
  } catch {
    // Not JSON: it is the Agents SDK's own tool-error text.
  }
  return text === SDK_GENERIC_ERROR ? { status: "SDK_TOOL_ERROR", text } : { status: "SDK_MESSAGE", text };
}

/**
 * The scripted model asks for each order in turn, one tool call per model turn, then gives a final answer.
 * `asks` are the RAW arguments the model writes: they may hold keys the schema does not know.
 */
export async function askModel(host: Host, asks: readonly Record<string, unknown>[]): Promise<AskOutcome> {
  const model = new ScriptedModel([
    ...asks.map((args, index) => [functionCall(host.tool.name, args, { callId: `call_${index + 1}` })]),
    [assistantMessage("done")],
  ]);
  const agent = new Agent({ name: "buyer", model, tools: [host.tool] });
  const result = await new Runner({ tracingDisabled: true }).run(agent, "Please place the orders.");
  if (result.interruptions && result.interruptions.length > 0) throw new Error("architecture A never pauses a run for approval");
  model.assertComplete();
  const toolOutputs = result.newItems
    .filter((item) => item.type === "tool_call_output_item")
    .map((item) => parseToolOutput((item.rawItem as { output?: unknown }).output));
  return { toolOutputs, modelCalls: model.calls.length };
}

/** The tool outputs of a run result, in order, as the model saw them. */
export function toolOutputsOf(result: { readonly newItems: readonly { readonly type: string; readonly rawItem?: unknown }[] }): ToolOutput[] {
  return result.newItems.filter((item) => item.type === "tool_call_output_item").map((item) => parseToolOutput((item.rawItem as { output?: unknown }).output));
}
