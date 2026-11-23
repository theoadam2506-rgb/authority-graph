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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GUARD = path.join(REPO_ROOT, "scripts/check-postgres-report.mjs");
/** The nine PostgreSQL suites the CI job runs, with their real test counts (98 in total). */
const SUITES: Readonly<Record<string, number>> = {
  "tests/storage/postgresEventStore.test.ts": 3,
  "tests/storage/postgresCapabilityIssuanceTransaction.test.ts": 15,
  "tests/storage/postgresAppendOnlyBoundary.test.ts": 14,
  "tests/storage/postgresCapabilityRedemptionTransaction.test.ts": 21,
  "tests/storage/postgresRedemptionProcesses.test.ts": 2,
  "tests/storage/postgresRedemptionReview.test.ts": 28,
  "tests/storage/postgresJournalHash.test.ts": 1,
  "tests/redemption/redemptionContract.postgres.test.ts": 8,
  "tests/sdk/authority.postgres.test.ts": 6,
};
const SUITE_NAMES = Object.keys(SUITES);
const EVENT_STORE_FILE = path.join(REPO_ROOT, "tests/storage/postgresEventStore.test.ts");

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

type SuiteOverrides = Readonly<Record<string, readonly AssertionStatus[] | null>>;

/** A report of the nine suites, all passing, with per-suite overrides (null removes the suite). */
function allSuites(overrides: SuiteOverrides = {}): Record<string, readonly AssertionStatus[]> {
  const files: Record<string, readonly AssertionStatus[]> = {};
  for (const [name, count] of Object.entries(SUITES)) {
    const override = overrides[name];
    if (override === null) continue;
    files[path.join(REPO_ROOT, name)] = override ?? passing(count);
  }
  return files;
}

describe("scripts/check-postgres-report.mjs", () => {
  it("accepts a report where all 98 PostgreSQL tests of the nine suites ran and passed", () => {
    const result = runGuardOn(vitestReport(allSuites()));
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("98/98 tests passed");
    expect(result.stdout).toContain("in 9 required files");
    expect(result.status).toBe(0);
  });

  it("accepts more than 98 passed tests (the floor is a minimum, not an exact count)", () => {
    const result = runGuardOn(vitestReport(allSuites({ "tests/storage/postgresEventStore.test.ts": passing(4) })));
    expect(result.status).toBe(0);
  });

  it("accepts Windows-style paths in testResults", () => {
    const files: Record<string, readonly AssertionStatus[]> = {};
    for (const [name, count] of Object.entries(SUITES)) files[`C:\\work\\authority-graph\\${name.replaceAll("/", "\\")}`] = passing(count);
    const result = runGuardOn(vitestReport(files));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  describe.each(SUITE_NAMES)("suite %s", (suite) => {
    it("fails the check when the suite is absent from the report (it was not run)", () => {
      const result = runGuardOn(vitestReport(allSuites({ [suite]: null })));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${suite} does not appear in testResults`);
    });

    it("fails the check when every test of the suite was skipped, even with the other seven passing", () => {
      const report = vitestReport(allSuites({ [suite]: skipped(SUITES[suite] ?? 1) }));
      expect(report["success"]).toBe(true);
      const result = runGuardOn(report);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${suite} has no passed test`);
      expect(result.stderr).toContain("were skipped or pending");
    });

    it("fails the check when a single test of the suite is skipped", () => {
      const count = SUITES[suite] ?? 1;
      const result = runGuardOn(vitestReport(allSuites({ [suite]: [...passing(count - 1), "skipped"] })));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("1 PostgreSQL test(s) were skipped or pending");
    });

    it("fails the check when the suite is present but has no assertion at all", () => {
      const result = runGuardOn(vitestReport(allSuites({ [suite]: [] })));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`${suite} has no passed test`);
    });
  });

  it("names every missing suite when several are absent (the five newer suites dropped from the CI command)", () => {
    const dropped = SUITE_NAMES.slice(3);
    const overrides: Record<string, null> = Object.fromEntries(dropped.map((name) => [name, null]));
    const result = runGuardOn(vitestReport(allSuites(overrides)));
    expect(result.status).toBe(1);
    for (const name of dropped) expect(result.stderr).toContain(`${name} does not appear in testResults`);
  });

  it("rejects a report where all PostgreSQL tests were skipped, even though Vitest calls it a success", () => {
    const files: Record<string, readonly AssertionStatus[]> = {};
    for (const [name, count] of Object.entries(SUITES)) files[path.join(REPO_ROOT, name)] = skipped(count);
    const report = vitestReport(files);
    expect(report["success"]).toBe(true);
    const result = runGuardOn(report);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PostgreSQL tests were skipped: the database was not reachable from the job");
    for (const name of SUITE_NAMES) expect(result.stderr).toContain(`${name} has no passed test`);
  });

  it("rejects todo tests", () => {
    const result = runGuardOn(vitestReport(allSuites({ "tests/storage/postgresRedemptionReview.test.ts": [...passing(28), "todo"] })));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("marked todo");
  });

  it("rejects failed tests", () => {
    const result = runGuardOn(vitestReport(allSuites({ [path.relative(REPO_ROOT, EVENT_STORE_FILE)]: ["passed", "failed", "passed"] })));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("1 PostgreSQL test(s) failed");
    expect(result.stderr).toContain("tests/storage/postgresEventStore.test.ts failed as a file");
  });

  it("rejects fewer than 98 passed tests when every suite still has a passing test", () => {
    const result = runGuardOn(vitestReport(allSuites({ "tests/storage/postgresRedemptionReview.test.ts": passing(27) })));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only 97 PostgreSQL test(s) passed, expected at least 98");
  });

  it("accepts a suite that grew and rejects one that shrank by a test (a deleted test is noticed)", () => {
    expect(runGuardOn(vitestReport(allSuites({ "tests/redemption/redemptionContract.postgres.test.ts": passing(9) }))).status).toBe(0);
    expect(runGuardOn(vitestReport(allSuites({ "tests/redemption/redemptionContract.postgres.test.ts": passing(7) }))).status).toBe(1);
  });

  it("requires exactly the files that the CI job runs: the list cannot drift from .github/workflows/ci.yml", () => {
    const listed = spawnSync(process.execPath, [GUARD, "--list-required"], { encoding: "utf8" });
    expect(listed.status).toBe(0);
    const required = listed.stdout.split("\n").filter((line) => line !== "").sort();
    expect(required).toEqual([...SUITE_NAMES].sort());

    const workflow = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    const step = workflow.slice(workflow.indexOf("- name: Run the PostgreSQL tests"), workflow.indexOf("- name: Check that no PostgreSQL test was skipped"));
    expect(step).not.toBe("");
    const inCi = [...step.matchAll(/\btests\/[\w./-]+\.test\.ts\b/g)].map((m) => m[0]).sort();
    expect(inCi).toEqual(required);
    expect(workflow).toContain("node scripts/check-postgres-report.mjs vitest-postgres.json");
  });

  it("the suite counts used here add up to the floor of the guard", () => {
    expect(Object.values(SUITES).reduce((a, b) => a + b, 0)).toBe(98);
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
