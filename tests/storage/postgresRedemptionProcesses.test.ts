/**
 * Redemption across REAL OS processes (not just pools): each child has its own
 * node process and its own PostgreSQL connections. Exclusion must come from the
 * database, not from anything in a process. Skipped without a database;
 * mandatory in CI.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AGENT, T, auth } from "../redemption/harness.js";
import { TEST_DATABASE_URL, databaseAvailable, pgHarness } from "../redemption/pgHarness.js";

const available = await databaseAvailable();
const WORKER = fileURLToPath(new URL("./support/redeemWorker.ts", import.meta.url));

function start(mode: "redeem" | "hold", schema: string, id: string): { child: ChildProcessWithoutNullStreams; lines: string[]; waitFor: (prefix: string) => Promise<string>; exited: Promise<void> } {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER, mode, schema, id], { env: { ...process.env, TEST_DATABASE_URL }, stdio: ["pipe", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiters: { prefix: string; resolve: (l: string) => void }[] = [];
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
  child.stdout.on("data", (c: Buffer) => {
    buffer += c.toString();
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      lines.push(line);
      for (const w of [...waiters]) if (line.startsWith(w.prefix)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    }
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const waitFor = (prefix: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const seen = lines.find((l) => l.startsWith(prefix));
      if (seen !== undefined) return resolve(seen);
      waiters.push({ prefix, resolve });
      child.once("exit", () => reject(new Error(`worker exited before "${prefix}": ${stderr.slice(0, 500)}`)));
    });
  return { child, lines, waitFor, exited };
}

describe.skipIf(!available)("redemption across real OS processes", () => {
  it("6 processes released at once redeem the same ticket: exactly one ok:true, one row", async () => {
    const t = await pgHarness({ label: "procs" });
    try {
      const id = await t.issue(T("09:10:00"));
      const workers = Array.from({ length: 6 }, () => start("redeem", t.iso.schema, id));
      await Promise.all(workers.map((w) => w.waitFor("READY"))); // every process is up and connected
      for (const w of workers) w.child.stdin.write("go\n"); // released together
      const results = (await Promise.all(workers.map((w) => w.waitFor("RESULT")))).map((l) => JSON.parse(l.slice("RESULT ".length)) as { ok: boolean; reason?: string });
      await Promise.all(workers.map((w) => w.exited));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const r of results) if (!r.ok) expect(["ALREADY_REDEEMED", "REDEMPTION_COLLISION"]).toContain(r.reason);
      expect((await t.pool.query("SELECT count(*) AS c FROM authority_events WHERE event_type = 'CAPABILITY_REDEEMED'")).rows[0].c).toBe("1");
    } finally {
      await t.close();
    }
  }, 60_000);

  it("a process SIGKILLed while holding the writer lock inside an open transaction releases it: another process then redeems exactly once", async () => {
    const t = await pgHarness({ label: "procs_kill" });
    try {
      const id = await t.issue(T("09:10:00"));
      const holder = start("hold", t.iso.schema, id);
      await holder.waitFor("LOCKED");
      const waiting = t.redemption.redeem(auth(AGENT), t.command(id), T("09:12:00")); // blocked behind the held lock
      await new Promise((r) => setTimeout(r, 400));
      expect((await t.pool.query("SELECT count(*) AS c FROM authority_events WHERE event_type = 'CAPABILITY_REDEEMED'")).rows[0].c).toBe("0");
      holder.child.kill("SIGKILL");
      await holder.exited;
      expect((await waiting).ok).toBe(true);
      expect((await t.pool.query("SELECT count(*) AS c FROM authority_events WHERE event_type = 'CAPABILITY_REDEEMED'")).rows[0].c).toBe("1");
    } finally {
      await t.close();
    }
  }, 60_000);
});
