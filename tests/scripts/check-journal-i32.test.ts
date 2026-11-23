/**
 * scripts/check-journal-i32.mjs: the READ-ONLY I32 compatibility check for an exported journal.
 * It must judge ticket counts correctly, fail closed on anything it cannot read, and never write.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts/check-journal-i32.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "i32-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], input?: string) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...(input !== undefined ? { input } : {}) });
const ticket = (action: string, cap: string) => ({ event_type: "CAPABILITY_ISSUED", payload: { action_id: action, capability_id: cap } });
const write = (name: string, value: unknown) => {
  const file = path.join(dir, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};

describe("check-journal-i32: verdicts", () => {
  it("the published vectors (regenerated for I32) are COMPATIBLE: exit 0", () => {
    const r = run([path.join(ROOT, "proof/vectors/journals/journal.json")]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("verdict: COMPATIBLE");
    expect(r.stdout).toContain("actions with more than one ticket: 0");
  });

  it("a journal with two tickets for one action is INCOMPATIBLE: exit 1, the action and its capabilities are listed", () => {
    const r = run([write("dup.json", [{ event_type: "ACTION_REQUESTED", payload: { action_id: "a1" } }, ticket("a1", "c1"), ticket("a1", "c2"), ticket("a2", "c3")])]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("OFFENDER a1: 2 tickets (c1, c2)");
    expect(r.stdout).toContain("verdict: INCOMPATIBLE");
    expect(r.stdout).not.toContain("OFFENDER a2");
  });

  it("one ticket per action, and an empty journal, are COMPATIBLE", () => {
    expect(run([write("ok.json", [ticket("a1", "c1"), ticket("a2", "c2")])]).status).toBe(0);
    expect(run([write("empty.json", [])]).status).toBe(0);
  });

  it("reads stdin with '-'", () => {
    expect(run(["-"], JSON.stringify([ticket("a1", "c1"), ticket("a1", "c2")])).status).toBe(1);
    expect(run(["-"], JSON.stringify([ticket("a1", "c1")])).status).toBe(0);
  });
});

describe("check-journal-i32: fails closed on what it cannot judge (exit 2, never a verdict)", () => {
  const bad: [string, () => string[], string][] = [
    ["no argument", () => [], "usage"],
    ["two arguments", () => ["a", "b"], "usage"],
    ["a missing file", () => [path.join(dir, "nope.json")], "cannot read"],
    ["a directory", () => [dir], "cannot read"],
    ["invalid JSON", () => [write("bad.json", "{not json")], "not valid JSON"],
    ["a JSON object, not an array", () => [write("obj.json", { events: [] })], "must be a JSON array"],
    ["an element that is not an event", () => [write("junk.json", [ticket("a", "c"), 42])], "event 1 is not an event"],
    ["a ticket without an action id", () => [write("noact.json", [{ event_type: "CAPABILITY_ISSUED", payload: {} }])], "without a payload.action_id"],
    ["a ticket with an empty action id", () => [write("emptyact.json", [{ event_type: "CAPABILITY_ISSUED", payload: { action_id: "" } }])], "without a payload.action_id"],
  ];
  for (const [name, args, message] of bad) {
    it(name, () => {
      const r = run(args());
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(message);
      expect(r.stdout).not.toContain("verdict");
    });
  }
});

describe("check-journal-i32: read only", () => {
  it("never modifies the journal it reads, and creates no file anywhere it is run", () => {
    const file = write("ro.json", [ticket("a1", "c1"), ticket("a1", "c2")]);
    const before = { hash: createHash("sha256").update(readFileSync(file)).digest("hex"), mtime: statSync(file).mtimeMs, listing: readdirSync(dir).sort() };
    run([file]);
    expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(before.hash);
    expect(statSync(file).mtimeMs).toBe(before.mtime);
    expect(readdirSync(dir).sort()).toEqual(before.listing);
  });

  it("contains no write, delete or network call", () => {
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/writeFile|appendFile|unlink|rmSync|rename|mkdir|createWriteStream|node:(http|https|net|child_process)|fetch\(/);
  });
});
