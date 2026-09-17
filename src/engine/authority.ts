/**
 * Public engine surface. `authorityAt` and `explainAction` share the exact
 * same resolution core (see authorityAt.ts's `resolveAuthority`, reused by
 * explainAction.ts) — this is not two engines glued together.
 */
export { authorityAt } from "./authorityAt.js";
export {
  explain,
  explainAction,
  findLateOrBackdatedEvents,
  type ApprovalDetail,
  type ChainLinkDetail,
  type ExplanationReport,
  type LateOrBackdatedObservation,
} from "./explainAction.js";
export { ingestAll, type IngestionClock, type IngestionResult } from "./ingest.js";
