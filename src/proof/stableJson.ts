/** Deterministic JSON for reports: object keys sorted recursively, 2-space indent, trailing newline. Arrays keep their order. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
export function stableStringify(v: unknown): string {
  return JSON.stringify(sortKeys(v), null, 2) + "\n";
}
