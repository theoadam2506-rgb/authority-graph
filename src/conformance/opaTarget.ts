/**
 * REAL target: Open Policy Agent, queried over its HTTP Data API
 * (POST /v1/data/authority_conformance/decision). The policy loaded into OPA
 * is conformance/opa/policy.rego, written by this project: the result is
 * "OPA running OUR policy agrees/disagrees with the engine", not an
 * independent assessment of OPA.
 */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { httpAdapter, type TargetAdapter } from "./adapter.js";

const run = promisify(execFile);
export const DEFAULT_POLICY_PATH = "conformance/opa/policy.rego";

export interface RunningOpa {
  readonly adapter: TargetAdapter;
  close(): Promise<void>;
}

function buildAdapter(baseUrl: string, details: Record<string, string | null>): TargetAdapter {
  return httpAdapter({
    descriptor: { kind: "real-system", name: "open-policy-agent", details },
    url: `${baseUrl}/v1/data/authority_conformance/decision`,
    buildBody: (req) => ({ input: req }),
    parse: (b) => {
      const result = (b as { result?: { allow?: unknown; reason?: unknown } }).result;
      if (result === undefined || typeof result.allow !== "boolean") return undefined; // undefined policy decision -> INCONCLUSIVE
      return { decision: result.allow ? "ALLOW" : "DENY", reason: typeof result.reason === "string" ? result.reason : null };
    },
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Connect to an OPA server that is already running (policy provenance and OPA version are not verifiable from here). */
export function connectOpa(baseUrl: string, policyPath: string, policySha256: string | null): RunningOpa {
  return {
    adapter: buildAdapter(baseUrl.replace(/\/$/, ""), {
      mode: "external-server", endpoint: baseUrl, opa_version: "not recorded (server was started outside the lab)",
      policy_file: policyPath, policy_sha256: policySha256, policy_loaded_by_lab: "false (assumed identical to policy_file; not verified)",
    }),
    close: async () => {},
  };
}

/** Start `opa run --server` on an ephemeral localhost port with the lab's policy, and stop it on close(). */
export async function spawnOpa(opaBin: string, policyPath = DEFAULT_POLICY_PATH): Promise<RunningOpa> {
  const version = (await run(opaBin, ["version"])).stdout.split("\n").find((l) => l.startsWith("Version:"))?.replace("Version:", "").trim() ?? "unknown";
  const policySha = await sha256File(policyPath);
  const port = await freePort();
  const child: ChildProcess = spawn(opaBin, ["run", "--server", "--addr", `127.0.0.1:${port}`, "--log-level", "error", policyPath], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`opa exited early (code ${child.exitCode}): ${stderr.trim()}`);
    try {
      if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error("opa did not become healthy within 10s"); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    adapter: buildAdapter(base, {
      mode: "spawned-by-lab", opa_version: version, policy_file: policyPath, policy_sha256: policySha, policy_loaded_by_lab: "true",
    }),
    close: () => new Promise((resolve) => { child.once("exit", () => resolve()); child.kill(); }),
  };
}
