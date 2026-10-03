#!/usr/bin/env node
/**
 * Checks that the demo excerpt in README.md still matches the real output of
 * `npm run demo`.
 *
 * The excerpt is the fenced code block between the markers
 * `<!-- demo-excerpt:start -->` and `<!-- demo-excerpt:end -->`. Every
 * non-blank line of that block must appear, as a whole line and in the same
 * order, in the demo's real output (trailing whitespace ignored). The rest of
 * the demo output is free to change: only the documented lines are pinned.
 *
 * Usage: node scripts/check-readme-demo-excerpt.mjs [README path]
 * (run from the repository root; the README path defaults to README.md)
 *
 * Plain Node, no dependency beyond the repository's own `tsx`, which the
 * demo already needs.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const START_MARKER = "<!-- demo-excerpt:start -->";
const END_MARKER = "<!-- demo-excerpt:end -->";

function fail(lines) {
  process.stderr.write(`README demo excerpt check FAILED:\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
  return 1;
}

function extractExcerpt(readme) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) {
    return { error: `could not find ${START_MARKER} ... ${END_MARKER} in the README` };
  }
  if (readme.indexOf(START_MARKER, start + 1) !== -1) {
    return { error: `${START_MARKER} appears more than once in the README` };
  }
  const between = readme.slice(start + START_MARKER.length, end);
  const fence = between.match(/^```[^\n]*\n([\s\S]*?)^```\s*$/m);
  if (fence === null || fence[1] === undefined) {
    return { error: "the demo excerpt markers must surround exactly one fenced code block" };
  }
  const lines = fence[1].split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
  if (lines.length === 0) {
    return { error: "the demo excerpt is empty" };
  }
  return { lines };
}

function main(argv) {
  const readmePath = argv[0] ?? "README.md";
  const { lines: excerpt, error } = extractExcerpt(readFileSync(readmePath, "utf8"));
  if (error !== undefined) {
    return fail([error]);
  }

  const demo = spawnSync(process.execPath, ["--import", "tsx", "demo/run.ts"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (demo.status !== 0) {
    return fail([`the demo itself failed (exit code ${demo.status ?? demo.signal}):`, ...`${demo.stderr ?? ""}`.trimEnd().split("\n")]);
  }
  const output = demo.stdout.split("\n").map((l) => l.trimEnd());

  // Every excerpt line must appear in the output, in order.
  const problems = [];
  let cursor = 0;
  for (const line of excerpt) {
    const next = output.indexOf(line, cursor);
    if (next !== -1) {
      cursor = next + 1;
      continue;
    }
    problems.push(
      output.includes(line)
        ? `out of order (appears in the demo output, but not after the previous excerpt line): ${JSON.stringify(line)}`
        : `no longer in the demo output: ${JSON.stringify(line)}`,
    );
  }
  if (problems.length > 0) {
    return fail([...problems, `Update the excerpt between ${START_MARKER} and ${END_MARKER} in ${readmePath} to match \`npm run demo\`.`]);
  }
  process.stdout.write(`README demo excerpt check passed: ${excerpt.length} documented line(s) found, in order, in the output of \`npm run demo\`.\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
