/**
 * The scenarios of the example, as data. `src/demo.ts` prints them; `test/scenarios.test.ts` asserts them.
 * Every scenario builds its own host (a fresh Authority journal and a fresh simulated supplier), and the
 * "model" is scripted. See the README for what each scenario does and does not show.
 */
import { createHost, type Host, type HostFaults } from "./host.js";
import { askModel, type ToolOutput } from "./scripted.js";
import type { SupplierBehaviour, SupplierOrder } from "./supplier.js";

export interface Step {
  /** What the scripted model asked for, in one line. */
  readonly asks: string;
  /** What the model was told (or the Agents SDK's own error text). */
  readonly told: ToolOutput;
}

export interface Part {
  readonly label: string;
  readonly steps: readonly Step[];
  /** What the simulated supplier holds at the end of this part. */
  readonly supplier: readonly SupplierOrder[];
  /** The Authority journal at the end of this part. */
  readonly journal: readonly string[];
  /** Facts about this part that only the host (not the model, not Authority) can see. */
  readonly facts: readonly string[];
}

export interface Scenario {
  readonly id: number;
  readonly title: string;
  readonly parts: readonly Part[];
  /** What this scenario does NOT show, when that is easy to mistake. */
  readonly notShown?: string;
}

const order = (orderRef: string, amountEur = 1800, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  orderRef,
  sku: "A-100",
  qty: 7,
  amountEur,
  supplier: "vendor-1",
  ...extra,
});

const describeAsk = (raw: Record<string, unknown>): string => `${String(raw.orderRef)}, ${Number(raw.amountEur).toLocaleString("en-US")} EUR, sku ${String(raw.sku)} x ${String(raw.qty)}, ${String(raw.supplier)}`;

/** One scripted run in which the model asks for each item in turn, one tool call per model turn. */
async function run(host: Host, asks: readonly Record<string, unknown>[]): Promise<Step[]> {
  const { toolOutputs } = await askModel(host, asks);
  return asks.map((raw, index) => ({ asks: describeAsk(raw), told: toolOutputs[index] ?? { status: "SDK_TOOL_ERROR", text: "no tool output" } }));
}

async function part(label: string, host: Host, steps: readonly Step[], facts: readonly string[] = []): Promise<Part> {
  return { label, steps, supplier: [...host.supplier.orders], journal: await host.journal(), facts };
}

async function withHost(options: { faults?: HostFaults; supplier?: SupplierBehaviour }, body: (host: Host) => Promise<Part>): Promise<Part> {
  const host = await createHost(options.faults ? { faults: options.faults } : {});
  if (options.supplier) host.supplier.behaviour = options.supplier;
  return body(host);
}

export async function runScenarios(): Promise<Scenario[]> {
  const scenarios: Scenario[] = [];

  // 1. An allowed order.
  scenarios.push({
    id: 1,
    title: "An order under the automatic limit is authorized and placed",
    parts: [await withHost({}, async (h) => part("1,800 EUR, the delegation allows 2,000 EUR on its own", h, await run(h, [order("ORDER-1")])))],
  });

  // 2. A refusal.
  scenarios.push({
    id: 2,
    title: "An order beyond the delegation is refused, and the supplier is never called",
    parts: [await withHost({}, async (h) => part("9,000 EUR, the delegation allows 5,000 EUR in total", h, await run(h, [order("ORDER-BIG", 9000)])))],
  });

  // 3. A human approval, recorded out of band.
  scenarios.push({
    id: 3,
    title: "An order above the automatic limit waits for a human; the host records the approval; the model asks again",
    parts: [
      await withHost({}, async (h) => {
        const before = await run(h, [order("ORDER-7", 3500)]);
        const supplierBefore = h.supplier.orders.length;
        await h.approve("po:ORDER-7");
        const after = await run(h, [order("ORDER-7", 3500)]);
        return part("3,500 EUR, then alice approves po:ORDER-7, then the same order is asked again", h, [...before, ...after], [`the supplier held ${supplierBefore} order(s) before the approval`]);
      }),
    ],
    notShown: "No native pause/resume. The run is not interrupted: the model is told to wait, and the host records the decision between two separate runs. That is architecture B.",
  });

  // 4. Modified arguments.
  scenarios.push({
    id: 4,
    title: "After the approval of one order, the same order reference with other arguments is refused",
    parts: [
      await withHost({}, async (h) => {
        const steps: Step[] = [];
        steps.push(...(await run(h, [order("ORDER-7", 3500)])));
        await h.approve("po:ORDER-7");
        steps.push(...(await run(h, [order("ORDER-7", 4900)])));
        steps.push(...(await run(h, [order("ORDER-7", 3500, { sku: "B-200" })])));
        steps.push(...(await run(h, [order("ORDER-7", 3500, { supplier: "vendor-2" })])));
        steps.push(...(await run(h, [order("ORDER-7", 3500)])));
        return part("approved: ORDER-7, 3,500 EUR, A-100, vendor-1", h, steps);
      }),
    ],
    notShown: "The adapter builds the call from one validated input, so the arguments cannot change between authorization and redemption inside it. What is shown is a changed request under the same order reference. The ticket-level check (ARGUMENTS_MISMATCH) is covered by the agent demo of Authority, not through this adapter.",
  });

  // 5. Revocation after the approval.
  scenarios.push({
    id: 5,
    title: "The delegation is revoked after the approval: the order is refused when the model asks again",
    parts: [
      await withHost({}, async (h) => {
        const steps: Step[] = [];
        steps.push(...(await run(h, [order("ORDER-7", 3500)])));
        await h.approve("po:ORDER-7");
        await h.revoke();
        steps.push(...(await run(h, [order("ORDER-7", 3500)])));
        steps.push(...(await run(h, [order("ORDER-8", 1800)])));
        return part("approved, then revoked by alice, then asked again", h, steps);
      }),
    ],
    notShown: "A revocation between authorization and redemption is NOT covered: guard() authorizes and redeems back to back, so here the revocation is caught when the model asks again, at authorization. The re-check at the instant of redemption would need architecture B2.",
  });

  // 6. Reuse of an action.
  scenarios.push({
    id: 6,
    title: "The same order is asked for again: nothing runs twice",
    parts: [
      await withHost({}, async (h) => part("an order placed, then asked again in the same run", h, await run(h, [order("ORDER-1"), order("ORDER-1")]))),
      await withHost({}, async (h) => {
        const steps: Step[] = [];
        // 2,400 EUR is above the automatic limit (so it needs an approval) and small enough that the budget is not what stops the repeat.
        steps.push(...(await run(h, [order("ORDER-9", 2400)])));
        await h.approve("po:ORDER-9");
        steps.push(...(await run(h, [order("ORDER-9", 2400), order("ORDER-9", 2400)])));
        return part("an approved order is consumed by its execution: the approval cannot be used again", h, steps);
      }),
      await withHost({ faults: { failToReportExecution: true } }, async (h) =>
        part("the order is placed, the journal write after it fails, then the order is asked again", h, await run(h, [order("ORDER-2"), order("ORDER-2")]), [
          "the journal holds CAPABILITY_REDEEMED and no ACTION_EXECUTED: the single-use ticket is consumed, whatever the report says",
        ]),
      ),
    ],
  });

  // 7. An uncertain external result.
  scenarios.push({
    id: 7,
    title: "The supplier completes the order but its reply is lost: the result is uncertain, never 'failed'",
    parts: [
      await withHost({ supplier: "completes-then-loses-reply" }, async (h) => {
        const steps: Step[] = [];
        steps.push(...(await run(h, [order("ORDER-3")])));
        steps.push(...(await run(h, [order("ORDER-3")])));
        return part("7a. the reply is lost; the same order is asked again", h, steps, [`the supplier holds ${h.supplier.orders.length} order(s)`]);
      }),
      await withHost({ supplier: "completes-then-loses-reply" }, async (h) => {
        const steps: Step[] = [];
        steps.push(...(await run(h, [order("ORDER-3")])));
        h.supplier.behaviour = "ok";
        steps.push(...(await run(h, [order("ORDER-3-RETRY")])));
        const keys = new Set(h.supplier.orders.map((o) => o.idempotencyKey));
        const refs = new Set(h.supplier.orders.map((o) => o.orderRef.replace(/-RETRY$/, "")));
        return part("7b. the model retries under ANOTHER order reference (a new action)", h, steps, [
          `the supplier now holds ${h.supplier.orders.length} orders for ${refs.size} business purchase, under ${keys.size} different idempotency keys`,
          "Authority cannot see that these two orders are the same purchase",
        ]);
      }),
      await withHost({ supplier: "rejects" }, async (h) =>
        part("7c. the supplier REFUSES the order (nothing is recorded): the model is told the same thing as in 7a", h, await run(h, [order("ORDER-4")])),
      ),
      await withHost({ faults: { loseFirstRedemptionAcknowledgement: true } }, async (h) => {
        const steps: Step[] = [];
        steps.push(...(await run(h, [order("ORDER-5")])));
        steps.push(...(await run(h, [order("ORDER-5")])));
        return part("7d. the redemption's acknowledgement is lost (before the supplier is called)", h, steps, [`the supplier holds ${h.supplier.orders.length} order(s)`]);
      }),
    ],
  });

  return scenarios;
}

const told = (output: ToolOutput): string => {
  switch (output.status) {
    case "EXECUTED":
      return `EXECUTED ${JSON.stringify(output.value)}${output.recorded ? "" : " (the journal write failed)"}`;
    case "NOT_EXECUTED":
      return `NOT_EXECUTED (${output.reason})`;
    case "APPROVAL_REQUIRED":
    case "OUTCOME_UNKNOWN":
      return output.status;
    case "SDK_TOOL_ERROR":
      return `SDK_TOOL_ERROR "${output.text}"`;
  }
};

/** The text the demo prints, and that `expected-output.txt` pins. */
export function formatScenarios(scenarios: readonly Scenario[]): string {
  const lines: string[] = [];
  for (const scenario of scenarios) {
    lines.push(`== ${scenario.id}. ${scenario.title}`);
    for (const p of scenario.parts) {
      lines.push(`   -- ${p.label}`);
      for (const s of p.steps) lines.push(`      the model asks: ${s.asks}`, `      it is told   : ${told(s.told)}`);
      lines.push(`      supplier holds: ${p.supplier.length} order(s)`);
      lines.push(`      journal       : ${p.journal.join(", ")}`);
      for (const f of p.facts) lines.push(`      host-side fact: ${f}`);
    }
    if (scenario.notShown) lines.push(`   NOT shown here: ${scenario.notShown}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
