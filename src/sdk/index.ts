/**
 * Authority SDK (experimental, not published). Public surface:
 * `createAuthority`, the two backends, the clock, the result types and the
 * two error classes. `authorityAt` is deliberately NOT exported from here:
 * it is a discovery view, not proof that one action may run.
 */
export { createAuthority, type Authority, type AuthorityConfig } from "./authority.js";
export { memoryBackend, postgresBackend, type Backend } from "./backend.js";
export { ClockError, systemClock, type TrustedClock } from "./clock.js";
export {
  AuthorityConfigError,
  AuthorityInputError,
  type AuthorizeResult,
  type EffectContext,
  type GuardResult,
  type RecordResult,
  type RedeemResult,
  type ReportResult,
  type Ticket,
  type ToolCall,
} from "./types.js";
