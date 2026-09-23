/**
 * M3 (contrat consolidé, debates/invoked-authority/QUESTION.md): the CLI
 * must render, post-execution, exactly these five sections, in this exact
 * order and under these exact labels:
 *   1. Available chain at decision
 *   2. Invoked canonical chain at decision
 *   3. Recorded delegation references
 *   4. Available chain now
 *   5. Invoked canonical chain now
 * Pre-execution (no ACTION_EXECUTED yet), only sections 4 and 5 render —
 * 1-3 require an execution and must not appear at all.
 *
 * None of the five may ever render as a silently blank/empty section when
 * the underlying result is "none" or "unresolvable": each must print an
 * explicit, non-empty line naming the actual decision/reason.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExplain } from "../../src/cli/authority.js";
import { monetaryParameters, thresholds } from "../../src/domain/types.js";
import { EUR, PURCHASE_ORDER_CREATE, THEO, actionExecution, actionRequest, delegationLink, rootDelegation } from "../fixtures/scenarios.js";
import type { AuthorityEvent } from "../../src/domain/events.js";

const SECTION_TITLES = [
  "Available chain at decision",
  "Invoked canonical chain at decision",
  "Recorded delegation references",
  "Available chain now",
  "Invoked canonical chain now",
] as const;

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir !== undefined) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

async function renderExplain(events: readonly AuthorityEvent[], actionId: string, atSequence: number): Promise<string> {
  tmpDir = await mkdtemp(path.join(tmpdir(), "authority-graph-cli-test-"));
  const eventsFile = path.join(tmpDir, "events.json");
  await writeFile(eventsFile, JSON.stringify(events, null, 2), "utf8");
  const result = await runExplain([
    "explain",
    actionId,
    "--events",
    eventsFile,
    "--at-sequence",
    String(atSequence),
    "--authority-time",
    "2030-01-01T00:00:00.000Z",
  ]);
  expect(result.exitCode).toBe(0);
  return result.output;
}

describe("M3 — post-execution CLI output has exactly five explicitly labeled sections, in order", () => {
  it("renders all five sections, in the exact given order, for an AUTHORIZED execution", async () => {
    const parameters = monetaryParameters(EUR(400));
    const store: AuthorityEvent[] = [
      rootDelegation({
        sequence: 1,
        id: "m3a-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: THEO, // grantee kept as THEO to avoid needing a second principal import; irrelevant to this rendering test
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        amountThresholds: thresholds(1_000, 1_000),
      }),
      actionRequest({
        sequence: 2,
        id: "m3a-action",
        requester: THEO,
        delegationId: "m3a-root",
        parameters,
      }),
      actionExecution({
        sequence: 3,
        actionId: "m3a-action",
        executor: THEO,
        decisionSequence: 2,
        chain: [delegationLink("m3a-root")],
        parameters,
      }),
    ];

    const output = await renderExplain(store, "m3a-action", 3);

    for (const title of SECTION_TITLES) {
      expect(output).toContain(`${title}:`);
    }
    const indices = SECTION_TITLES.map((title) => output.indexOf(`${title}:`));
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]!).toBeGreaterThan(indices[i - 1]!);
    }
    // Resolved sections show the actual delegation, not a blank line.
    expect(output).toContain("m3a-root");
    // The removed legacy section label must never reappear.
    expect(output).not.toContain("Authority chain:");
  });

  it("prints an explicit, non-empty reason for 'Available chain at decision' when the decision is REQUIRES_APPROVAL, never a blank section", async () => {
    const parameters = monetaryParameters(EUR(500));
    const store: AuthorityEvent[] = [
      rootDelegation({
        sequence: 1,
        id: "m3b-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: THEO,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        amountThresholds: thresholds(100, 1_000), // 500 falls in the approval band
      }),
      actionRequest({
        sequence: 2,
        id: "m3b-action",
        requester: THEO,
        delegationId: "m3b-root",
        parameters,
      }),
      actionExecution({
        sequence: 3,
        actionId: "m3b-action",
        executor: THEO,
        decisionSequence: 2,
        chain: [delegationLink("m3b-root")],
        parameters,
      }),
    ];

    const output = await renderExplain(store, "m3b-action", 3);

    const section = output.split("Available chain at decision:")[1]?.split("\n\n")[0] ?? "";
    expect(section.trim().length).toBeGreaterThan(0);
    expect(section).toContain("REQUIRES_APPROVAL");
  });
});

describe("M3 — pre-execution CLI output has only the two '... now' sections", () => {
  it("renders 'Available chain now' and 'Invoked canonical chain now' but none of the three 'at decision'/'recorded' sections", async () => {
    const parameters = monetaryParameters(EUR(400));
    const store: AuthorityEvent[] = [
      rootDelegation({
        sequence: 1,
        id: "m3c-root",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: THEO,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        amountThresholds: thresholds(1_000, 1_000),
      }),
      actionRequest({
        sequence: 2,
        id: "m3c-action",
        requester: THEO,
        delegationId: "m3c-root",
        parameters,
      }),
    ];

    const output = await renderExplain(store, "m3c-action", 2);

    expect(output).toContain("Available chain now:");
    expect(output).toContain("Invoked canonical chain now:");
    expect(output).not.toContain("Available chain at decision:");
    expect(output).not.toContain("Invoked canonical chain at decision:");
    expect(output).not.toContain("Recorded delegation references:");
    // The removed legacy section label must never reappear, pre-execution either.
    expect(output).not.toContain("Authority chain:");
  });
});

describe("M3 — 'unresolvable'/'none' sections keep their exact title and a non-empty, real explanation", () => {
  it("a delegation invoked before it is created renders 'none' and 'unresolvable' at decision, then resolves normally now", async () => {
    const parameters = monetaryParameters(EUR(400));
    // The request names "m3d-d1" before any DELEGATION_CREATED for it exists —
    // same causal-impossibility shape as M7b: at decisionSequence, no chain can
    // exist for it at all (authorityAtDecision: UNKNOWN -> "Available chain at
    // decision": none) and its structural ancestry cannot be reconstructed
    // ("Invoked canonical chain at decision": unresolvable). Only created
    // afterward, so "now" (queried after that) resolves both normally.
    const store: AuthorityEvent[] = [
      actionRequest({
        sequence: 1,
        id: "m3d-action",
        requester: THEO,
        delegationId: "m3d-d1",
        parameters,
      }),
      actionExecution({
        sequence: 2,
        actionId: "m3d-action",
        executor: THEO,
        decisionSequence: 1,
        chain: [delegationLink("m3d-d1")],
        parameters,
      }),
      rootDelegation({
        sequence: 3,
        id: "m3d-d1",
        grantor: THEO,
        grantorType: "HUMAN_ROOT",
        grantee: THEO,
        capabilities: [PURCHASE_ORDER_CREATE],
        canDelegate: false,
        amountThresholds: thresholds(1_000, 1_000),
      }),
    ];

    const output = await renderExplain(store, "m3d-action", 3);

    for (const title of SECTION_TITLES) {
      expect(output).toContain(`${title}:`);
    }
    expect(output).not.toContain("Authority chain:");

    // "Available chain at decision": none — carries the real UNKNOWN/C24 decision, not a blank line.
    const availableAtDecision = output.split("Available chain at decision:")[1]?.split("\n\n")[0] ?? "";
    expect(availableAtDecision.trim().length).toBeGreaterThan(0);
    expect(availableAtDecision).toContain("none");
    expect(availableAtDecision).toContain("C24_NO_VALID_CHAIN");

    // "Invoked canonical chain at decision": unresolvable — explicit, not blank.
    const invokedAtDecision = output.split("Invoked canonical chain at decision:")[1]?.split("\n\n")[0] ?? "";
    expect(invokedAtDecision.trim().length).toBeGreaterThan(0);
    expect(invokedAtDecision).toContain("unresolvable");

    // Both "now" sections resolve normally once m3d-d1 actually exists.
    const availableNow = output.split("Available chain now:")[1]?.split("\n\n")[0] ?? "";
    expect(availableNow).toContain("m3d-d1");
    const invokedNow = output.split("Invoked canonical chain now:")[1] ?? "";
    expect(invokedNow).toContain("m3d-d1");
  });
});
