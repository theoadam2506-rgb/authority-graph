/**
 * Tests for scripts/check-postgres-report.mjs, the guard that makes the
 * PostgreSQL CI job fail when the PostgreSQL tests were skipped, failed, or
 * not run at all. The script is executed as a real child process so that its
 * exit code, the only thing CI looks at, is what gets asserted.
 *
 * `vitestReport()` mirrors the shape of a real Vitest 2.1.9 JSON report
 * (`--reporter=json`), including the fact that a fully skipped file still has
 * a file-level status of "passed".
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = path.join(REPO_ROOT, "scripts/check-postgres-report.mjs");
const EVENT_STORE_FILE = path.join(REPO_ROOT, "tests/storage/postgresEventStore.test.ts");
const ISSUANCE_FILE = path.join(REPO_ROOT, "tests/storage/postgresCapabilityIssuanceTransaction.test.ts");

type AssertionStatus = "passed" | "failed" | "skipped" | "pending" | "todo";

function vitestReport(files: Readonly<Record<string, readonly AssertionStatus[]>>): Record<string, unknown> {
  const all = Object.values(files).flat();
  const count = (status: AssertionStatus): number => all.filter((s) => s === status).length;
  return {
    numTotalTestSuites: Object.keys(files).length * 2,
    numPassedTestSuites: Object.keys(files).length * 2,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: all.length,
    numPassedTests: count("passed"),
    numFailedTests: count("failed"),
    numPendingTests: count("skipped") + count("pending"),
    numTodoTests: count("todo"),
    snapshot: { added: 0, failure: false, filesAdded: 0, filesRemoved: 0, filesRemovedList: [], filesUnmatched: 0, filesUpdated: 0, matched: 0, total: 0, unchecked: 0, uncheckedKeysByFile: [], unmatched: 0, updated: 0, didUpdate: false },
    startTime: 0,
    success: count("failed") === 0,
    testResults: Object.entries(files).map(([name, statuses]) => ({
      assertionResults: statuses.map((status, i) => ({
        ancestorTitles: ["suite"],
        fullName: `suite test ${i + 1}`,
        status,
        title: `test ${i + 1}`,
        failureMessages: status === "failed" ? ["AssertionError: expected true to be false"] : [],
        meta: {},
      })),
      startTime: 0,
      endTime: 0,
      status: statuses.includes("failed") ? "failed" : "passed",
      message: "",
      name,
    })),
  };
}

const passing = (n: number): AssertionStatus[] => Array.from({ length: n }, () => "passed");
const skipped = (n: number): AssertionStatus[] => Array.from({ length: n }, () => "skipped");

const workDir = mkdtempSync(path.join(tmpdir(), "check-postgres-report-"));
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

let fileCounter = 0;
function runGuardOnContent(content: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  fileCounter += 1;
  const reportPath = path.join(workDir, `report-${fileCounter}.json`);
  writeFileSync(reportPath, content, "utf8");
  return runGuard(reportPath);
}
function runGuard(reportPath: string): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [GUARD, reportPath], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
function runGuardOn(report: unknown): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  return runGuardOnContent(JSON.stringify(report));
}

describe("scripts/check-postgres-report.mjs", () => {
  it("accepts a report where all 17 PostgreSQL tests ran and passed", () => {
    const result = runGuardOn(vitestReport({ [EVENT_STORE_FILE]: passing(3), [ISSUANCE_FILE]: passing(14) }));
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("17/17 tests passed");
    expect(result.status).toBe(0);
  });

  it("accepts more than 17 passed tests (the floor is a minimum, not an exact count)", () => {
    const result = runGuardOn(vitestReport({ [EVENT_STORE_FILE]: passing(4), [ISSUANCE_FILE]: passing(15) }));
    expect(result.status).toBe(0);
  });

  it("accepts Windows-style paths in testResults", () => {
    const result = runGuardOn(
      vitestReport({
        "C:\\work\\authority-graph\\tests\\storage\\postgresEventStore.test.ts": passing(3),
        "C:\\work\\authority-graph\\tests\\storage\\postgresCapabilityIssuanceTransaction.test.ts": passing(14),
      }),
    );
    expect(result.status).toBe(0);
  });

  it("rejects a report where all 17 PostgreSQL tests were skipped, even though Vitest calls it a success", () => {
    const report = vitestReport({ [EVENT_STORE_FILE]: skipped(3), [ISSUANCE_FILE]: skipped(14) });
    expect(report["success"]).toBe(true);
    const result = runGuardOn(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PostgreSQL tests were skipped: the database was not reachable from the job");
    expect(result.stderr).toContain("tests/storage/postgresEventStore.test.ts has no passed test");
    expect(result.stderr).toContain("tests/storage/postgresCapabilityIssuanceTransaction.test.ts has no passed test");
  });

  it("rejects a partially skipped report", () => {
    const result = runGuardOn(vitestReport({ [EVENT_STORE_FILE]: passing(3), [ISSUANCE_FILE]: [...passing(13), "skipped"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1 PostgreSQL test(s) were skipped or pending");
  });

  it("rejects todo tests", () => {
    const result = runGuardOn(vitestReport({ [EVENT_STORE_FILE]: passing(3), [ISSUANCE_FILE]: [...passing(14), "todo"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("marked todo");
  });

  it("rejects failed tests", () => {
    const result = runGuardOn(vitestReport({ [EVENT_STORE_FILE]: ["passed", "failed", "passed"], [ISSUANCE_FILE]: passing(14) }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1 PostgreSQL test(s) failed");
    expect(result.stderr).toContain("tests/storage/postgresEventStore.test.ts failed as a file");
  });

  it("rejects fewer than 17 passed tests", () => {
    const result = runGuardOn(vitestReport({ [EVENT_STORE_FILE]: passing(3), [ISSUANCE_FILE]: passing(10) }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only 13 PostgreSQL test(s) passed, expected at least 17");
  });

  it("rejects a report where a required test file is absent", () => {
    const result = runGuardOn(vitestReport({ [ISSUANCE_FILE]: passing(17) }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tests/storage/postgresEventStore.test.ts does not appear in testResults");
  });

  it("rejects a report where one file has no passed test, even if the totals are met", () => {
    const result = runGuardOn(vitestReport({ [EVENT_STORE_FILE]: [], [ISSUANCE_FILE]: passing(17) }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tests/storage/postgresEventStore.test.ts has no passed test");
  });

  it("rejects an incomplete report (missing counters and testResults)", () => {
    const result = runGuardOn({ numTotalTests: 17, numPassedTests: 17 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the report is incomplete: missing or non-integer field(s) numFailedTests, numPendingTests, numTodoTests");
    expect(result.stderr).toContain("missing `testResults` array");
  });

  it("rejects a report that is not valid JSON", () => {
    const result = runGuardOnContent('{"numTotalTests": 17,');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is not valid JSON");
  });

  it("rejects a missing report file", () => {
    const result = runGuard(path.join(workDir, "does-not-exist.json"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is missing (file not found)");
  });

  it("exits with a usage error when no report path is given", () => {
    const result = spawnSync(process.execPath, [GUARD], { encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage:");
  });
});
