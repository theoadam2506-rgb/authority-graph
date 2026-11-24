/**
 * The architecture B scenarios, printed by `npm run demo:b` and pinned by `expected-output-b.txt`.
 * The model is scripted; the store is in memory; the tokens are simulated. See the README for what each one shows and
 * what a real deployment still needs.
 */
import { Runner } from "@openai/agents";
import { assistantMessage, modelError } from "@openai/agents/testing";
import type { DecisionOutcome, RunOutcome } from "./approval.js";
import { callOrder, createBridgeKit, order, type BridgeKit } from "./bridgeKit.js";
import { toolOutputsOf, type ToolOutput } from "./scripted.js";

export interface BridgeScenario {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
  /** What this scenario does NOT show, when that is easy to mistake. */
  readonly notShown?: string;
}

const money = (value: number): string => value.toLocaleString("en-US");

function told(output: ToolOutput): string {
  switch (output.status) {
    case "EXECUTED":
      return `EXECUTED ${JSON.stringify(output.value)}${output.recorded ? "" : " (the journal write failed)"}`;
    case "NOT_EXECUTED":
      return `NOT_EXECUTED (${output.reason})`;
    case "APPROVAL_REQUIRED":
    case "OUTCOME_UNKNOWN":
      return output.status;
    case "SDK_TOOL_ERROR":
    case "SDK_MESSAGE":
      return `${output.status} "${output.text}"`;
  }
}

function run(outcome: RunOutcome): string {
  switch (outcome.status) {
    case "WAITING":
      return `WAITING, ${outcome.approvals.map((a) => `${a.approvalId} for ${a.summary.actionId} (${money(a.summary.amount?.value ?? 0)} EUR to ${a.summary.recipient})`).join("; ")}`;
    case "DONE":
      return `DONE, the model was told: ${outcome.toolResults.length === 0 ? "(no tool result)" : outcome.toolResults.map(told).join(" | ")}`;
    case "FAILED":
      return `FAILED (${outcome.errorName}); the effect may have run`;
    case "REFUSED":
      return `REFUSED (${outcome.reason})`;
  }
}

const decision = (d: DecisionOutcome): string => (d.status === "DECIDED" ? `DECIDED (${d.decision})` : `REFUSED (${d.reason}${d.detail ? `: ${d.detail}` : ""})`);

const facts = async (kit: BridgeKit): Promise<string[]> => [`supplier holds: ${kit.host.supplier.orders.length} order(s)`, `journal: ${(await kit.host.journal()).join(", ")}`];

const waiting = (outcome: RunOutcome) => {
  if (outcome.status !== "WAITING") throw new Error(`expected a paused run, got ${outcome.status}`);
  return outcome;
};

export async function runBridgeScenarios(): Promise<BridgeScenario[]> {
  const scenarios: BridgeScenario[] = [];

  // B1. The complete flow.
  {
    const kit = await createBridgeKit();
    const o = kit.register(order("ORDER-7"));
    const lines: string[] = [];
    const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
    lines.push(`the model asks for ORDER-7 (${money(o.amountEur)} EUR): ${run(first)}`, `supplier holds: ${kit.host.supplier.orders.length} order(s), the run is paused`);
    const approval = first.approvals[0]!;
    lines.push(`alice approves ${approval.approvalId} (with her simulated token): ${decision(await kit.coordinator.decide({ approvalId: approval.approvalId, decision: "approve", credential: "token-alice" }))}`);
    lines.push(`resume ${first.runId}: ${run(await kit.coordinator.resume(first.runId))}`);
    lines.push(...(await facts(kit)));
    scenarios.push({ id: "B1", title: "Approval, interruption, resume, execution", lines });
  }

  // B2. A human refuses.
  {
    const kit = await createBridgeKit();
    const o = kit.register(order("ORDER-7"));
    const lines: string[] = [];
    const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
    lines.push(`paused: ${run(first)}`);
    lines.push(`alice rejects: ${decision(await kit.coordinator.decide({ approvalId: first.approvals[0]!.approvalId, decision: "reject", credential: "token-alice" }))}`);
    lines.push(`resume: ${run(await kit.coordinator.resume(first.runId))}`);
    lines.push(...(await facts(kit)));
    scenarios.push({ id: "B2", title: "A human rejects the order", lines, notShown: "Authority journals the refusal, but a refusal does not make the action permanently denied: asking again needs a human again." });
  }

  // B3. Revocation during the wait.
  {
    const lines: string[] = [];
    {
      const kit = await createBridgeKit();
      const o = kit.register(order("ORDER-7"));
      const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
      lines.push(`-- B3a. alice revokes the delegation BEFORE she decides`, `paused: ${run(first)}`);
      await kit.host.revoke();
      lines.push(`alice approves: ${decision(await kit.coordinator.decide({ approvalId: first.approvals[0]!.approvalId, decision: "approve", credential: "token-alice" }))}`);
      lines.push(`resume: ${run(await kit.coordinator.resume(first.runId))}`, ...(await facts(kit)));
    }
    {
      const kit = await createBridgeKit();
      const o = kit.register(order("ORDER-7"));
      const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
      lines.push(`-- B3b. alice approves, THEN the delegation is revoked, then the run resumes`);
      lines.push(`alice approves: ${decision(await kit.coordinator.decide({ approvalId: first.approvals[0]!.approvalId, decision: "approve", credential: "token-alice" }))}`);
      await kit.host.revoke();
      lines.push(`resume: ${run(await kit.coordinator.resume(first.runId))}`, ...(await facts(kit)));
    }
    scenarios.push({ id: "B3", title: "The delegation is revoked while a human is deciding", lines });
  }

  // B4. The reviewer's identity.
  {
    const kit = await createBridgeKit();
    const o = kit.register(order("ORDER-7"));
    const lines: string[] = [];
    const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
    const id = first.approvals[0]!.approvalId;
    for (const [who, credential] of [["no credential", undefined], ["an unknown token", "token-unknown"], ["mallory (authenticated, not the grantor)", "token-mallory"], ["the agent itself (authenticated)", "token-agent"], ["alice", "token-alice"]] as const) {
      lines.push(`${who} approves: ${decision(await kit.coordinator.decide({ approvalId: id, decision: "approve", credential }))}`);
    }
    lines.push(`resume: ${run(await kit.coordinator.resume(first.runId))}`, ...(await facts(kit)));
    scenarios.push({
      id: "B4",
      title: "Who may approve: the host authenticates, Authority decides who is allowed",
      lines,
      notShown: "The tokens are SIMULATED (a plain object). Authority compares the asserted name with the delegation's grantor; it authenticates nobody.",
    });
  }

  // B5. Authority and the SDK disagree.
  {
    const lines: string[] = [];
    const runner = new Runner({ tracingDisabled: true });
    {
      const kit = await createBridgeKit();
      const o = kit.register(order("ORDER-7"));
      const agent = kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]);
      const first = await runner.run(agent, "go");
      first.state.approve(first.interruptions![0]!);
      const second = await runner.run(agent, first.state);
      lines.push(`-- B5a. the SDK approves, nothing is recorded in Authority`, `the model was told: ${toolOutputsOf(second).map(told).join(" | ")}`, ...(await facts(kit)));
    }
    {
      const kit = await createBridgeKit();
      const first = kit.register(order("ORDER-7"));
      const second = kit.register(order("ORDER-8"));
      const agent = kit.agent([[callOrder(first, "call_1")], [callOrder(second, "call_2")], [assistantMessage("done")]]);
      const paused = await runner.run(agent, "go");
      await kit.host.approve("po:ORDER-7");
      paused.state.approve(paused.interruptions![0]!, { alwaysApprove: true });
      const done = await runner.run(agent, paused.state);
      lines.push(`-- B5b. a sticky alwaysApprove, then a second order that no human approved`, `interruptions for ORDER-8: ${done.interruptions?.length ?? 0} (the SDK stopped asking)`, `the model was told: ${toolOutputsOf(done).map(told).join(" | ")}`, ...(await facts(kit)));
    }
    {
      const kit = await createBridgeKit();
      const o = kit.register(order("ORDER-7"));
      const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
      await kit.host.approve("po:ORDER-7"); // recorded in Authority only, outside the coordinator
      lines.push(`-- B5c. Authority already holds the approval, but the SDK run is still paused`, `resume: ${run(await kit.coordinator.resume(first.runId))}`);
      lines.push(`alice decides: ${decision(await kit.coordinator.decide({ approvalId: first.approvals[0]!.approvalId, decision: "approve", credential: "token-alice" }))}`);
      lines.push(`resume: ${run(await kit.coordinator.resume(first.runId))}`, ...(await facts(kit)));
    }
    scenarios.push({ id: "B5", title: "Authority and the OpenAI state disagree", lines, notShown: "In every case the effect is decided by guard(), never by the SDK's pause or approval. A sticky approval only removes the pause: the model is then told that approval is required." });
  }

  // B6. Double decision, double resume.
  {
    const kit = await createBridgeKit();
    const o = kit.register(order("ORDER-7"));
    const lines: string[] = [];
    const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
    const id = first.approvals[0]!.approvalId;
    const both = await Promise.all([kit.coordinator.decide({ approvalId: id, decision: "approve", credential: "token-alice" }), kit.coordinator.decide({ approvalId: id, decision: "approve", credential: "token-alice" })]);
    lines.push(`two decisions at the same time: ${both.map(decision).sort().join(" and ")}`);
    const resumes = await Promise.all([kit.coordinator.resume(first.runId), kit.coordinator.resume(first.runId)]);
    lines.push(`two resumes at the same time: ${resumes.map(run).sort().join(" and ")}`, ...(await facts(kit)));
    scenarios.push({ id: "B6", title: "Double decision and double resume", lines, notShown: "The compare-and-set is atomic only inside one event loop. Several processes need a real transactional store." });
  }

  // B7. A tampered snapshot or record.
  {
    const lines: string[] = [];
    {
      const kit = await createBridgeKit();
      const o = kit.register(order("ORDER-7"));
      const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
      await kit.coordinator.decide({ approvalId: first.approvals[0]!.approvalId, decision: "approve", credential: "token-alice" });
      kit.restart((data) => {
        for (const r of data.runs) r.snapshot = r.snapshot.replaceAll("2400", "4900");
      });
      lines.push(`-- B7a. the stored RunState is edited (the amount 2400 becomes 4900)`, `resume: ${run(await kit.coordinator.resume(first.runId))}`, ...(await facts(kit)));
    }
    {
      const kit = await createBridgeKit();
      const o = kit.register(order("ORDER-7"));
      const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
      await kit.coordinator.decide({ approvalId: first.approvals[0]!.approvalId, decision: "approve", credential: "token-alice" });
      kit.restart((data) => {
        for (const a of data.approvals) if (a.call.amount) a.call.amount.value = 4900;
      });
      lines.push(`-- B7b. the coordinator's own record of the approved call is edited`, `resume: ${run(await kit.coordinator.resume(first.runId))}`, ...(await facts(kit)));
    }
    scenarios.push({
      id: "B7",
      title: "A tampered snapshot or record",
      lines,
      notShown: "Here the edit is caught by the coordinator, which compares the snapshot with its own record of what was approved (the Agents SDK also checks an approved invocation; a test shows it). Neither is authentication: a real deployment must verify the integrity of the snapshot and bind it to the run and the user.",
    });
  }

  // B8. The order registry.
  {
    const lines: string[] = [];
    const kit = await createBridgeKit({ supplier: "completes-then-loses-reply" });
    const o = kit.register(order("ORDER-7"));
    const invented = order("ORDER-INVENTED");
    lines.push(`the model invents a reference: ${run(await kit.coordinator.start(kit.agent([[callOrder(invented, "call_1")], [assistantMessage("done")]]), "go"))}`);
    lines.push(`the model changes the amount of a registered order (4,900 instead of 2,400): ${run(await kit.coordinator.start(kit.agent([[callOrder(o, "call_2", { amountEur: 4900 })], [assistantMessage("done")]]), "go"))}`);
    lines.push(`journal so far: ${(await kit.host.journal()).join(", ")}`);
    const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_3")], [assistantMessage("done")]]), "place the registered order"));
    await kit.coordinator.decide({ approvalId: first.approvals[0]!.approvalId, decision: "approve", credential: "token-alice" });
    lines.push(`-- the registered order is approved; the supplier completes it but its reply is lost`, `resume: ${run(await kit.coordinator.resume(first.runId))}`, `supplier holds: ${kit.host.supplier.orders.length} order(s)`);
    lines.push(`the model asks for ORDER-7 again: ${run(await kit.coordinator.start(kit.agent([[callOrder(o, "call_4")], [assistantMessage("done")]]), "retry"))}`);
    lines.push(`the model invents ORDER-7-RETRY to retry: ${run(await kit.coordinator.start(kit.agent([[callOrder(order("ORDER-7-RETRY"), "call_5")], [assistantMessage("done")]]), "retry"))}`);
    kit.host.supplier.behaviour = "ok";
    const second = kit.register(order("ORDER-7B"));
    const retry = waiting(await kit.coordinator.start(kit.agent([[callOrder(second, "call_6")], [assistantMessage("done")]]), "the host registered ORDER-7B for the same purchase"));
    await kit.coordinator.decide({ approvalId: retry.approvals[0]!.approvalId, decision: "approve", credential: "token-alice" });
    lines.push(`-- the HOST registers ORDER-7B for the same purchase and a human approves it`, `resume: ${run(await kit.coordinator.resume(retry.runId))}`, `supplier holds: ${kit.host.supplier.orders.length} order(s), for ${new Set(kit.host.supplier.orders.map((x) => x.orderRef.replace(/(-RETRY|B)$/, ""))).size} purchase`);
    scenarios.push({
      id: "B8",
      title: "The order registry: no invented reference, and the limit of what it can know",
      lines,
      notShown: "The registry stops a model from inventing a reference. It cannot know that two orders the HOST registered are the same purchase: that duplicate is not prevented here, and the target must deduplicate.",
    });
  }

  // B9. Failure windows.
  {
    const lines: string[] = [];
    {
      const kit = await createBridgeKit();
      const o = kit.register(order("ORDER-7"));
      const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
      const id = first.approvals[0]!.approvalId;
      kit.store.failTransitionTo = ["APPROVED"];
      lines.push(`-- B9a. Authority records the approval, then the coordinator cannot persist the decision`, `alice approves: ${decision(await kit.coordinator.decide({ approvalId: id, decision: "approve", credential: "token-alice" }))}`);
      lines.push(`journal holds the approval: ${(await kit.host.journal()).includes("APPROVAL_GRANTED")}`, `resume: ${run(await kit.coordinator.resume(first.runId))}`);
      lines.push(`alice tries again: ${decision(await kit.coordinator.decide({ approvalId: id, decision: "approve", credential: "token-alice" }))}`);
      lines.push(`recovery releases ${await kit.coordinator.recoverStuckDecisions()} stuck decision(s)`);
      lines.push(`alice decides again: ${decision(await kit.coordinator.decide({ approvalId: id, decision: "approve", credential: "token-alice" }))}`, `resume: ${run(await kit.coordinator.resume(first.runId))}`, ...(await facts(kit)));
    }
    {
      const kit = await createBridgeKit();
      const o = kit.register(order("ORDER-7"));
      const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
      await kit.coordinator.decide({ approvalId: first.approvals[0]!.approvalId, decision: "approve", credential: "token-alice" });
      kit.restart();
      lines.push(`-- B9b. the decision is persisted, then the process restarts before the resume`, `resume after the restart: ${run(await kit.coordinator.resume(first.runId))}`, ...(await facts(kit)));
    }
    {
      const kit = await createBridgeKit();
      const o = kit.register(order("ORDER-7"));
      const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
      await kit.coordinator.decide({ approvalId: first.approvals[0]!.approvalId, decision: "approve", credential: "token-alice" });
      kit.queueResume([modelError(new Error("model unavailable"))], [[assistantMessage("done")]]);
      lines.push(`-- B9c. the effect runs, then the NEXT model call fails during the resume`, `resume: ${run(await kit.coordinator.resume(first.runId))}`, `supplier holds: ${kit.host.supplier.orders.length} order(s)`);
      lines.push(`retry the resume: ${run(await kit.coordinator.retryResume(first.runId))}`, ...(await facts(kit)));
    }
    {
      const kit = await createBridgeKit({ faults: { failToReportExecution: true } });
      const o = kit.register(order("ORDER-7"));
      const first = waiting(await kit.coordinator.start(kit.agent([[callOrder(o, "call_1")], [assistantMessage("done")]]), "place the order"));
      await kit.coordinator.decide({ approvalId: first.approvals[0]!.approvalId, decision: "approve", credential: "token-alice" });
      lines.push(`-- B9d. the effect runs and the journal write after it fails; the coordinator then crashes before it records FINISHED`, `resume: ${run(await kit.coordinator.resume(first.runId))}`);
      kit.restart((data) => {
        for (const r of data.runs) if (r.runId === first.runId) r.status = "WAITING";
      });
      lines.push(`the restarted coordinator resumes the same snapshot: ${run(await kit.coordinator.resume(first.runId))}`, ...(await facts(kit)));
    }
    scenarios.push({
      id: "B9",
      title: "Failure windows between the Authority write, the coordinator's persistence and the OpenAI resume",
      lines,
      notShown: "The restart is simulated at the application level: the Authority journal here is in memory and would not survive a real restart. A real deployment needs the PostgreSQL backend and a durable store.",
    });
  }

  return scenarios;
}

/** The text the demo prints, and that `expected-output-b.txt` pins. */
export function formatBridgeScenarios(scenarios: readonly BridgeScenario[]): string {
  const lines: string[] = [];
  for (const scenario of scenarios) {
    lines.push(`== ${scenario.id}. ${scenario.title}`);
    for (const line of scenario.lines) lines.push(line.startsWith("--") ? `   ${line}` : `      ${line}`);
    if (scenario.notShown) lines.push(`   NOT shown here: ${scenario.notShown}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
