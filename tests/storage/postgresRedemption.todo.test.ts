/**
 * Checklist for the future PostgreSQL redemption pull request (NOT implemented,
 * NOT run: `it.todo` only). Each line is a property the PostgreSQL
 * implementation must demonstrate against a real PostgreSQL 16, in addition to
 * plugging a `ContractEnv` into `tests/redemption/redemptionContract.ts`
 * (collisions, independent redeemers, restart, raw duplicate writes).
 * Use one schema per file (`tests/storage/pgTestSchema.ts`, issue #13).
 */
import { describe, it } from "vitest";

describe("PostgreSQL redemption (planned, see SPEC I28 'persistent stores')", () => {
  it.todo("the contract suite passes with `spawn()` = another pool + store + transaction over the same schema (another process)");
  it.todo("50 concurrent redemptions from 5 independent pools: exactly one ok:true, one CAPABILITY_REDEEMED row");
  it.todo("a raw INSERT of a second CAPABILITY_REDEEMED row for the same capability_id (different event_id and sequence) fails with unique_violation 23505");
  it.todo("a unique_violation during redemption is reported ALREADY_REDEEMED/REDEMPTION_COLLISION and rolls the transaction back (no partial row, sequence not skipped)");
  it.todo("success is reported only when this transaction inserted the row (a no-op or ON CONFLICT DO NOTHING insert is never success)");
  it.todo("an identical duplicate row (same event_id, same content) is a no-op and the ticket stays consumed");
  it.todo("event_id reuse with different content is refused (EVENT_ID_CONFLICT) and logged in security_log");
  it.todo("closing every pool and reopening (restart) between issue and redeem, and between redeem and retry, behaves as the contract C2/C3 require");
  it.todo("a connection killed (pg_terminate_backend) mid-redemption leaves either no row or exactly one valid row, never a half-written state");
  it.todo("a revocation committed by another connection between the redeemer's read and its insert is impossible under the writer lock, or yields CONCURRENT_WRITE_DETECTED with ticketConsumed");
  it.todo("decision_sequence equals the row's sequence minus one for every committed redemption, and validateRedemptionEvent accepts it");
  it.todo("the application role (append-only boundary) can redeem: it needs only SELECT and INSERT, no UPDATE, no DELETE");
  it.todo("an additive migration creating the unique index is idempotent and applies to a database that already holds CAPABILITY_ISSUED rows");
});
