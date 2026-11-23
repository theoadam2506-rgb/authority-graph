#!/usr/bin/env node
/**
 * Builds the SDK package into .sdk-package/ (compiled JavaScript, type
 * declarations, a package.json written here, the SQL files and the licence)
 * and, with --pack, runs `npm pack` on it. It publishes NOTHING: the generated
 * manifest is `"private": true`, so `npm publish` refuses it. Removing that line
 * is a deliberate release step that belongs to the maintainer.
 *
 *   node scripts/build-sdk-package.mjs           build only
 *   node scripts/build-sdk-package.mjs --pack    build, then write the .tgz next to the repository root
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, ".sdk-package");
const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed (${result.status})`);
    process.exit(result.status ?? 1);
  }
};

rmSync(out, { recursive: true, force: true });
run(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "tsconfig.sdk.json")], root);

const manifest = {
  name: "authority-graph-sdk",
  version: rootPackage.version,
  description: "In-process TypeScript SDK for Authority Graph: ask before an agent acts, redeem a single-use capability, report the result. Experimental.",
  license: "Apache-2.0",
  type: "module",
  // Not for publication: `npm publish` refuses a private package. Remove this line only as a deliberate release decision.
  private: true,
  main: "./dist/sdk/index.js",
  types: "./dist/sdk/index.d.ts",
  exports: {
    ".": { types: "./dist/sdk/index.d.ts", default: "./dist/sdk/index.js" },
    "./sql/schema.sql": "./sql/schema.sql",
    "./sql/roles.sql": "./sql/roles.sql",
    "./sql/check_i32_readonly.sql": "./sql/check_i32_readonly.sql",
    "./package.json": "./package.json",
  },
  files: ["dist", "sql", "README.md", "LICENSE", "NOTICE"],
  sideEffects: false,
  engines: { node: ">=20" },
  // @types/pg is a types-only dependency: the declarations of `postgresBackend` mention the `Pool` type, and a memory-only TypeScript user must still compile without skipLibCheck.
  dependencies: { "json-canonicalize": rootPackage.dependencies["json-canonicalize"], "@types/pg": rootPackage.devDependencies["@types/pg"] },
  // The driver itself is only needed for `postgresBackend(pool)`; the memory backend never loads it.
  peerDependencies: { pg: rootPackage.dependencies.pg },
  peerDependenciesMeta: { pg: { optional: true } },
  repository: { type: "git", url: "git+https://github.com/theoadam2506-rgb/authority-graph.git" },
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

mkdirSync(join(out, "sql"));
for (const file of ["schema.sql", "roles.sql", "check_i32_readonly.sql"]) cpSync(join(root, "src", "storage", file), join(out, "sql", file));
cpSync(join(root, "docs", "v1", "SDK_QUICKSTART.md"), join(out, "README.md"));
for (const file of ["LICENSE", "NOTICE"]) cpSync(join(root, file), join(out, file));

// The SDK must stay free of a runtime dependency on the database driver and of any file of the repository outside src/.
const leaks = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (path.endsWith(".js") && /from\s+["']pg["']|require\(["']pg["']\)/.test(readFileSync(path, "utf8"))) leaks.push(path);
  }
};
walk(join(out, "dist"));
if (leaks.length > 0) {
  console.error(`The compiled SDK imports "pg" at runtime (it must be a type-only dependency):\n${leaks.join("\n")}`);
  process.exit(1);
}
if (!existsSync(join(out, "dist", "sdk", "index.js")) || !existsSync(join(out, "dist", "sdk", "index.d.ts"))) {
  console.error("The build did not produce dist/sdk/index.js and index.d.ts");
  process.exit(1);
}
console.log(`SDK package built in ${out}`);

if (process.argv.includes("--pack")) run("npm", ["pack", out, "--pack-destination", root, "--silent"], root);
