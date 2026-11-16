/**
 * SIMULATED target: a tiny HTTP decision service written by this project to
 * exercise the lab's PASS and FAIL paths. It is NOT a real product and NOT
 * OPA. The `faulty-*` modes inject a bug on purpose; a FAIL against them is
 * the lab working as intended, never a vulnerability in any real system.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { httpAdapter, type BinaryDecision, type TargetAdapter, type TargetRequest } from "./adapter.js";

export type SimulatedMode = "compliant" | "faulty-revocation" | "faulty-delegation";
export const SIMULATED_MODES: readonly SimulatedMode[] = ["compliant", "faulty-revocation", "faulty-delegation"];

type Grant = Extract<TargetRequest["log"][number], { type: "delegate" | "subdelegate" }>;

function decide(req: TargetRequest, mode: SimulatedMode): { decision: BinaryDecision; reason: string } {
  const grants = new Map<string, Grant>();
  const revoked = new Set<string>();
  for (const e of req.log) {
    if (e.type === "delegate" || e.type === "subdelegate") grants.set(e.id, e);
    else if (e.type === "revoke") revoked.add(e.target);
  }
  const r = req.request;
  const leaf = [...grants.values()].find((g) => g.grantee === r.agent);
  if (leaf === undefined) return { decision: "DENY", reason: "no delegation to agent" };
  // Walk up the chain. `faulty-delegation` only inspects the leaf grant (does not bound it by its parent).
  let cur: Grant | undefined = leaf;
  while (cur !== undefined) {
    if (mode !== "faulty-revocation" && revoked.has(cur.id)) return { decision: "DENY", reason: `${cur.id} revoked` };
    if (!cur.capabilities.includes(r.capability)) return { decision: "DENY", reason: `${cur.id} does not cover capability` };
    if (cur.limit.currency !== r.amount.currency || r.amount.value > cur.limit.value) return { decision: "DENY", reason: `${cur.id} limit exceeded` };
    if (cur.type === "delegate") return cur.grantor === r.human_root ? { decision: "ALLOW", reason: "chain valid" } : { decision: "DENY", reason: "root is not the human root" };
    const parent: Grant | undefined = grants.get(cur.parent);
    if (parent === undefined) return { decision: "DENY", reason: "missing parent" };
    if (mode !== "faulty-delegation") {
      if (!parent.can_delegate || parent.grantee !== cur.grantor) return { decision: "DENY", reason: "parent did not allow delegation to grantor" };
      if (cur.limit.value > parent.limit.value || cur.limit.currency !== parent.limit.currency || cur.capabilities.some((c) => !parent.capabilities.includes(c))) {
        return { decision: "DENY", reason: `${cur.id} exceeds its parent` };
      }
      cur = parent;
    } else {
      // Bug: trusts the leaf, skips every ancestor's limits (and revocation of ancestors is out of scope here).
      if (revoked.has(cur.id)) return { decision: "DENY", reason: `${cur.id} revoked` };
      return { decision: "ALLOW", reason: "leaf grant covers request (ancestors not checked)" };
    }
  }
  return { decision: "DENY", reason: "unreachable" };
}

export interface RunningSimulatedTarget {
  readonly adapter: TargetAdapter;
  close(): Promise<void>;
}

export async function startSimulatedTarget(mode: SimulatedMode): Promise<RunningSimulatedTarget> {
  const server: Server = createServer((httpReq, res) => {
    const chunks: Buffer[] = [];
    httpReq.on("data", (c: Buffer) => chunks.push(c));
    httpReq.on("end", () => {
      try {
        const out = decide(JSON.parse(Buffer.concat(chunks).toString("utf8")) as TargetRequest, mode);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ decision: out.decision.toLowerCase(), reason: out.reason }));
      } catch {
        res.writeHead(400);
        res.end("bad request");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const adapter = httpAdapter({
    descriptor: {
      kind: "simulated",
      name: `simulated-target:${mode}`,
      details: {
        note: mode === "compliant" ? "in-process stand-in written by this project; not a real product" : "in-process stand-in with a DELIBERATELY injected bug; a FAIL here is not a real vulnerability",
        mode,
      },
    },
    url: `http://127.0.0.1:${port}/decide`,
    buildBody: (req) => req,
    parse: (b) => {
      const o = b as { decision?: unknown; reason?: unknown };
      if (o.decision === "allow") return { decision: "ALLOW", reason: typeof o.reason === "string" ? o.reason : null };
      if (o.decision === "deny") return { decision: "DENY", reason: typeof o.reason === "string" ? o.reason : null };
      return undefined;
    },
  });
  return { adapter, close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}
