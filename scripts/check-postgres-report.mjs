#!/usr/bin/env node
/**
 * Guard for the PostgreSQL CI job: reads a Vitest JSON report and fails
 * unless every PostgreSQL test actually ran and passed.
 *
 * Why this exists: the PostgreSQL test files use `describe.skipIf(...)` when
 * no database is reachable. In that case Vitest exits with code 0 and reports
 * `"success": true` with every test pending, so a job that only checks the
 * exit code would be green without running a single PostgreSQL test.
 *
 * Usage: node scripts/check-postgres-report.mjs <vitest-json-report>
 *
 * Plain Node, no dependency. The report shape it reads is the one produced by
 * Vitest's built-in `json` reporter (checked against Vitest 2.1.9).
 */
import { readFileSync } from "node:fs";

/**
 * Floor on the number of passed PostgreSQL tests. 17 is the number of
 * PostgreSQL tests at the time this guard was introduced (3 in
 * postgresEventStore.test.ts, 14 in postgresCapabilityIssuanceTransaction.test.ts).
 * New tests may raise the real count; `numPassedTests === numTotalTests`
 * covers them. Never lower this floor silently.
 */
const MIN_PASSED_TESTS = 17;

/** The test files the PostgreSQL job must run, relative to the repository root. */
const REQUIRED_TEST_FILES = [
  "tests/storage/postgresEventStore.test.ts",
  "tests/storage/postgresCapabilityIssuanceTransaction.test.ts",
];

const COUNT_FIELDS = ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests", "numTodoTests"];

function toPosix(p) {
  return p.replaceAll("\\", "/");
}

/**
 * Pure check of an already-parsed report. Returns the list of violations
 * (empty when the report is acceptable).
 */
function checkReport(report) {
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    return ["the report is not a JSON object: this is not a Vitest JSON report"];
  }

  const errors = [];
  const missingCounts = COUNT_FIELDS.filter((field) => !Number.isInteger(report[field]));
  if (missingCounts.length > 0) {
    errors.push(`the report is incomplete: missing or non-integer field(s) ${missingCounts.join(", ")}`);
  }
  if (!Array.isArray(report.testResults)) {
    errors.push("the report is incomplete: missing `testResults` array");
  }
  if (errors.length > 0) {
    return errors;
  }

  const { numTotalTests, numPassedTests, numFailedTests, numPendingTests, numTodoTests } = report;

  if (numFailedTests !== 0) {
    errors.push(`${numFailedTests} PostgreSQL test(s) failed (numFailedTests = ${numFailedTests}, expected 0)`);
  }
  if (numPendingTests !== 0) {
    errors.push(
      numPassedTests === 0
        ? `PostgreSQL tests were skipped: the database was not reachable from the job (numPendingTests = ${numPendingTests}, numPassedTests = 0). Check the postgres service, its health check and TEST_DATABASE_URL.`
        : `${numPendingTests} PostgreSQL test(s) were skipped or pending (numPendingTests = ${numPendingTests}, expected 0)`,
    );
  }
  if (numTodoTests !== 0) {
    errors.push(`${numTodoTests} PostgreSQL test(s) are marked todo (numTodoTests = ${numTodoTests}, expected 0)`);
  }
  if (numPassedTests < MIN_PASSED_TESTS) {
    errors.push(`only ${numPassedTests} PostgreSQL test(s) passed, expected at least ${MIN_PASSED_TESTS}`);
  }
  if (numPassedTests !== numTotalTests) {
    errors.push(`not every collected test passed: numPassedTests = ${numPassedTests}, numTotalTests = ${numTotalTests}`);
  }

  for (const required of REQUIRED_TEST_FILES) {
    const fileResult = report.testResults.find(
      (r) => r !== null && typeof r === "object" && typeof r.name === "string" && (toPosix(r.name) === required || toPosix(r.name).endsWith(`/${required}`)),
    );
    if (fileResult === undefined) {
      errors.push(`${required} does not appear in testResults: the file was not run`);
      continue;
    }
    if (fileResult.status === "failed") {
      const message = typeof fileResult.message === "string" && fileResult.message !== "" ? `: ${fileResult.message}` : "";
      errors.push(`${required} failed as a file${message}`);
    }
    // A file-level "passed" status is not enough: Vitest reports it for a
    // fully skipped file too. Require at least one assertion that passed.
    const assertions = Array.isArray(fileResult.assertionResults) ? fileResult.assertionResults : [];
    const passed = assertions.filter((a) => a !== null && typeof a === "object" && a.status === "passed").length;
    if (passed === 0) {
      const statuses = [...new Set(assertions.map((a) => a?.status))].join(", ") || "no assertions";
      errors.push(`${required} has no passed test (assertion statuses: ${statuses})`);
    }
  }

  return errors;
}

/** Reads, parses and checks a report file. Returns the list of violations. */
function checkReportFile(reportPath) {
  let raw;
  try {
    raw = readFileSync(reportPath, "utf8");
  } catch (err) {
    const reason = err !== null && typeof err === "object" && "code" in err && err.code === "ENOENT" ? "file not found" : String(err);
    return [`the report ${reportPath} is missing (${reason}): Vitest did not write it, or the test step did not run`];
  }
  let report;
  try {
    report = JSON.parse(raw);
  } catch (err) {
    return [`the report ${reportPath} is not valid JSON (${err instanceof Error ? err.message : String(err)})`];
  }
  return checkReport(report);
}

function main(argv) {
  const reportPath = argv[0];
  if (reportPath === undefined || argv.length !== 1) {
    process.stderr.write("usage: node scripts/check-postgres-report.mjs <vitest-json-report>\n");
    return 2;
  }
  const errors = checkReportFile(reportPath);
  if (errors.length > 0) {
    process.stderr.write(`PostgreSQL report check FAILED (${reportPath}):\n`);
    for (const error of errors) {
      process.stderr.write(`  - ${error}\n`);
    }
    return 1;
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  process.stdout.write(
    `PostgreSQL report check passed: ${report.numPassedTests}/${report.numTotalTests} tests passed, 0 failed, 0 skipped, 0 todo, in ${REQUIRED_TEST_FILES.length} required files.\n`,
  );
  return 0;
}

process.exitCode = main(process.argv.slice(2));
