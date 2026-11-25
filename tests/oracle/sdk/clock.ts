/**
 * SDK clock. The engine never reads a clock; the SDK is the one place a time
 * source is wired in, and it is wired in EXPLICITLY (decision D34): there is
 * no default clock. `systemClock` exists so that choosing the machine clock is
 * a visible, greppable act, and so its trust assumption can be documented:
 * whoever controls this clock controls expiry and revocation timing.
 */
import { iso8601, type Iso8601 } from "../../../src/domain/types.js";

/** `now()` must return a canonical UTC instant: `YYYY-MM-DDTHH:mm:ss.sssZ`. */
export interface TrustedClock {
  now(): string;
}

/** The machine clock. A trust assumption of the deployment, not a guarantee. */
export const systemClock: TrustedClock = { now: () => new Date().toISOString() };

const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Thrown when the injected clock fails. The message is fixed text: whatever the clock threw is kept in `cause` (non-enumerable), never in the message. */
export class ClockError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClockError";
  }
}

/** Reads the clock once and refuses anything that is not a canonical, real UTC instant (fail closed). */
export function readClock(clock: TrustedClock): Iso8601 {
  let value: unknown;
  try {
    value = clock.now();
  } catch (cause) {
    throw new ClockError("The clock threw", { cause });
  }
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ClockError("The clock must return a canonical UTC instant such as 2026-01-01T00:00:00.000Z");
  }
  return iso8601(value);
}
