#!/usr/bin/env node
/**
 * Proves that the SDK package works from a project OUTSIDE this repository:
 * builds the package, packs it with `npm pack` into a throwaway directory,
 * installs the tarball in a throwaway project (nothing is published, no
 * persistent database is touched), type-checks and runs the documented
 * quickstart under two TypeScript module settings, and checks the exports
 * adversarially. Needs network access to the npm registry for the two small
 * dependencies of the throwaway project, like `npm ci` does.
 *
 *   node scripts/check-sdk-package.mjs [--keep]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};
const run = (command, args, cwd, options = {}) => spawnSync(command, args, { cwd, encoding: "utf8", ...options });
const must = (label, result) => {
  if (result.status !== 0) {
    console.error(`${label} failed (${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    process.exit(1);
  }
  return result;
};

const work = mkdtempSync(join(tmpdir(), "authority-sdk-check-"));
const finish = () => {
  if (!keep) rmSync(work, { recursive: true, force: true });
  else console.log(`kept: ${work}`);
};

// 1. Build and pack.
must("build", run(process.execPath, [join(root, "scripts", "build-sdk-package.mjs")], root));
const packed = JSON.parse(must("npm pack", run("npm", ["pack", join(root, ".sdk-package"), "--pack-destination", work, "--json"], root)).stdout)[0];
const tarball = join(work, packed.filename);

// 2. The tarball holds exactly what it should hold.
const allowed = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^NOTICE$/, /^sql\/[a-z0-9_]+\.sql$/, /^dist\/(domain|engine|sdk|storage)\/[A-Za-z0-9_]+\.(js|d\.ts)$/];
for (const file of packed.files.map((f) => f.path)) check(allowed.some((re) => re.test(file)), `unexpected file in the tarball: ${file}`);
const names = packed.files.map((f) => f.path);
for (const required of ["package.json", "README.md", "LICENSE", "dist/sdk/index.js", "dist/sdk/index.d.ts", "sql/schema.sql", "sql/roles.sql"]) check(names.includes(required), `missing from the tarball: ${required}`);
check(!names.some((n) => /\.map$|\.env|\btests?\b|node_modules|\.ts$/.test(n) && !n.endsWith(".d.ts")), "the tarball must hold no source, test, map or environment file");
check(!names.some((n) => /^dist\/(cli|conformance|proof)\//.test(n)), "the SDK tarball must not ship the CLI, the conformance lab or the proof tooling");
const manifest = JSON.parse(readFileSync(join(root, ".sdk-package", "package.json"), "utf8"));
check(manifest.private === true, "the generated package must stay private (no accidental publication)");
check(manifest.engines?.node === ">=20", "engines.node must be >=20");
check(Object.keys(manifest.dependencies).sort().join() === "@types/pg,json-canonicalize", "unexpected dependencies");
check(manifest.peerDependenciesMeta?.pg?.optional === true, "pg must be an optional peer dependency");

// 3. A throwaway project outside the repository installs the tarball.
const app = join(work, "app");
mkdirSync(app);
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }));
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
must("npm install", run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", tarball, `typescript@${rootPackage.devDependencies.typescript.replace(/^[^\d]*/, "")}`, `@types/node@${rootPackage.devDependencies["@types/node"].replace(/^[^\d]*/, "")}`], app));
check(!existsSync(join(app, "node_modules", "pg")), "pg must not be installed by the SDK (optional peer)");
check(existsSync(join(app, "node_modules", "authority-graph-sdk", "dist", "sdk", "index.js")), "the package was not installed");

// 4. The documented quickstart, extracted from the documentation itself, type-checks and runs.
const doc = readFileSync(join(root, "docs", "v1", "SDK_QUICKSTART.md"), "utf8");
const snippet = doc.match(/<!-- quickstart-code -->\s*```ts\n([\s\S]*?)\n```/)?.[1];
check(snippet !== undefined, "the quickstart code block was not found in docs/v1/SDK_QUICKSTART.md");
writeFileSync(join(app, "quickstart.ts"), snippet ?? "");

// Fail-closed behaviour and the export surface, from the outside.
writeFileSync(join(app, "adversarial.ts"), `
import * as sdk from "authority-graph-sdk";
import { AuthorityConfigError, AuthorityInputError, createAuthority, createEventBuilders, memoryBackend, systemClock } from "authority-graph-sdk";

const keys = Object.keys(sdk).sort().join();
if (keys !== "AuthorityConfigError,AuthorityInputError,ClockError,createAuthority,createEventBuilders,memoryBackend,postgresBackend,systemClock") throw new Error("unexpected exports: " + keys);

// @ts-expect-error authorityAt is deliberately not exported
const missing = sdk.authorityAt;
if (missing !== undefined) throw new Error("authorityAt must not be exported");

// There is no default clock: omitting it is a type error AND a runtime refusal.
let refused = 0;
try { // @ts-expect-error clock is required
  createAuthority({ backend: memoryBackend(), enforcementPointId: "gw" }); } catch (e) { if (e instanceof AuthorityConfigError) refused++; }
try { // @ts-expect-error clock is required
  createEventBuilders({}); } catch (e) { if (e instanceof AuthorityInputError) refused++; }
if (refused !== 2) throw new Error("missing clock must be refused");

// A hostile call is refused or blocked, never executed.
const authority = createAuthority({ backend: memoryBackend(), clock: systemClock, enforcementPointId: "gw" });
const blocked = await authority.guard({ actionId: "x", agentId: "nobody", delegationId: "none", capability: { resource: "r", action: "a" } }, async () => { throw new Error("the effect must not run"); });
if (blocked.status !== "BLOCKED") throw new Error("an undelegated call must be blocked, got " + blocked.status);

// A forged ticket is refused (the SDK only accepts what authorize() returned).
try { await authority.redeem({ capabilityId: "cap-1" } as never, {} as never); throw new Error("a forged ticket must not be accepted"); } catch (e) { if (!(e instanceof AuthorityInputError)) throw e; }

// Typed builders: wrong shape is a compile error, hostile data is a runtime error.
const events = createEventBuilders({ clock: systemClock });
// @ts-expect-error unknown key
try { events.revocation({ delegationId: "d", revokedBy: "o", reasonCode: "X", extra: 1 }); throw new Error("unknown key accepted"); } catch (e) { if (!(e instanceof AuthorityInputError)) throw e; }
console.log("adversarial checks passed");
`);

for (const [label, module, moduleResolution] of [["NodeNext", "NodeNext", "NodeNext"], ["Bundler", "ESNext", "Bundler"]]) {
  const dir = join(app, `out-${label}`);
  const tsconfig = {
    compilerOptions: { target: "ES2022", module, moduleResolution, lib: ["ES2022"], types: ["node"], strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: false, outDir: dir, rootDir: app, esModuleInterop: true },
    files: ["quickstart.ts", "adversarial.ts"],
  };
  writeFileSync(join(app, `tsconfig.${label}.json`), JSON.stringify(tsconfig));
  const tsc = run(process.execPath, [join(app, "node_modules", "typescript", "bin", "tsc"), "-p", join(app, `tsconfig.${label}.json`)], app);
  // skipLibCheck is OFF so that the package's own declarations are really checked. A third-party declaration
  // that does not compile (for example pg-protocol under some @types/node versions) is not ours: only errors in
  // the consumer's files and in authority-graph-sdk fail the check.
  const own = `${tsc.stdout}${tsc.stderr}`.split("\n").filter((line) => /error TS\d+/.test(line) && (!line.startsWith("node_modules/") || line.startsWith("node_modules/authority-graph-sdk/")));
  check(own.length === 0, `type-check failed under ${label} (skipLibCheck false):\n${own.join("\n")}`);
  if (own.length === 0) {
    // The compiled output lives under the consumer project so that the package resolves from its node_modules.
    for (const name of ["quickstart", "adversarial"]) {
      const result = run(process.execPath, [join(dir, `${name}.js`)], app);
      check(result.status === 0, `${name} (${label}) failed:\n${result.stdout}${result.stderr}`);
      if (name === "quickstart") check(/second redemption and changed arguments refused/.test(result.stdout), `the quickstart (${label}) did not print its final line`);
    }
  }
}

// 5. Deep imports are closed; the SQL files and package.json are reachable on purpose.
writeFileSync(join(app, "exports.mjs"), `
const results = {};
for (const path of ["authority-graph-sdk/dist/sdk/authority.js", "authority-graph-sdk/dist/engine/authorityAt.js", "authority-graph-sdk/src/sdk/index.ts", "authority-graph-sdk/dist/sdk/index.js"]) {
  try { await import(path); results[path] = "resolved"; } catch (e) { results[path] = e.code; }
}
const sql = import.meta.resolve("authority-graph-sdk/sql/schema.sql");
console.log(JSON.stringify({ results, sql: sql.endsWith("/sql/schema.sql") }));
`);
const exportsRun = run(process.execPath, [join(app, "exports.mjs")], app);
check(exportsRun.status === 0, `exports probe failed:\n${exportsRun.stderr}`);
if (exportsRun.status === 0) {
  const { results, sql } = JSON.parse(exportsRun.stdout);
  for (const path of Object.keys(results)) check(results[path] === "ERR_PACKAGE_PATH_NOT_EXPORTED", `deep import ${path} must be refused with ERR_PACKAGE_PATH_NOT_EXPORTED, got ${results[path]}`);
  check(sql, "authority-graph-sdk/sql/schema.sql must resolve");
}

finish();
if (failures.length > 0) {
  console.error(`SDK package check FAILED (${failures.length}):\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`SDK package check passed: ${packed.filename}, ${packed.files.length} files, ${packed.size} bytes packed, Node ${process.versions.node}, NodeNext and Bundler, nothing published.`);
