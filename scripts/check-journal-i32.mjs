#!/usr/bin/env node
/**
 * I32 compatibility check for an EXPORTED journal. READ ONLY: it reads one file (or
 * stdin), prints a report and writes nothing, anywhere.
 *
 * Usage: node scripts/check-journal-i32.mjs <journal.json | ->
 *
 * The journal is a JSON array of canonical events (the format `authority proof`
 * reads). Exit status: 0 compatible (no action holds more than one
 * CAPABILITY_ISSUED), 1 INCOMPATIBLE (the offending actions are listed), 2 usage
 * error, unreadable file or malformed journal. It judges ticket counts only; it
 * does not validate the journal (use `authority proof verify` for that).
 * Plain Node, no dependency. See docs/v1/COMPATIBILITY_I32.md.
 */
import { readFileSync } from "node:fs";

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
  process.stderr.write("usage: node scripts/check-journal-i32.mjs <journal.json | ->\n");
  process.exit(2);
}

let text;
try {
  text = readFileSync(args[0] === "-" ? 0 : args[0], "utf8");
} catch (error) {
  fail(`cannot read the journal: ${error && error.code ? error.code : "unreadable"}`);
}

let events;
try {
  events = JSON.parse(text);
} catch {
  fail("the journal is not valid JSON");
}
if (!Array.isArray(events)) fail("the journal must be a JSON array of events");

const perAction = new Map();
let tickets = 0;
for (const [index, event] of events.entries()) {
  if (typeof event !== "object" || event === null || typeof event.event_type !== "string") fail(`event ${index} is not an event (no event_type)`);
  if (event.event_type !== "CAPABILITY_ISSUED") continue;
  const actionId = event.payload && event.payload.action_id;
  if (typeof actionId !== "string" || actionId === "") fail(`event ${index} is a CAPABILITY_ISSUED without a payload.action_id`);
  tickets += 1;
  perAction.set(actionId, [...(perAction.get(actionId) ?? []), event.payload.capability_id]);
}

const offenders = [...perAction].filter(([, ids]) => ids.length > 1).sort(([a], [b]) => (a < b ? -1 : 1));
const out = [`events: ${events.length}`, `CAPABILITY_ISSUED: ${tickets}`, `actions ticketed: ${perAction.size}`, `actions with more than one ticket: ${offenders.length}`];
for (const [action, ids] of offenders) out.push(`  OFFENDER ${action}: ${ids.length} tickets (${ids.join(", ")})`);
out.push(`verdict: ${offenders.length === 0 ? "COMPATIBLE" : "INCOMPATIBLE"}`);
process.stdout.write(`${out.join("\n")}\n`);
process.exit(offenders.length === 0 ? 0 : 1);
