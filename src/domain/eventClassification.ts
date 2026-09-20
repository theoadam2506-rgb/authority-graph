/**
 * PR4B-1 — classifies the 9 current event types along one axis: who is
 * allowed to ASSERT this kind of fact. This is deliberately NOT the same
 * axis as "does Authority trust this fact" (EVIDENCE vs ACCOUNTING, already
 * established for ACTION_EXECUTED/CAPABILITY_ISSUED elsewhere in this
 * codebase) — see the two unions' docstrings below for why ACTION_EXECUTED
 * stays externally-asserted rather than being reclassified.
 *
 * Pure types only. No logic, no runtime behavior.
 */
import type { AuthorityEventType, DraftAuthorityEvent } from "./events.js";

/**
 * Event types that ONLY Authority itself may ever produce the content of —
 * never a source's own assertion, however sincere. Today this is exactly
 * one type; it will grow (CAPABILITY_REDEEMED, and later others) as more
 * of the capability lifecycle is built, but never by reclassifying an
 * existing externally-asserted type into this union — see
 * ExternallyAssertedEventType's docstring on why that temptation must be
 * resisted for ACTION_EXECUTED specifically.
 */
export type AuthorityGeneratedEventType = "CAPABILITY_ISSUED";

/**
 * Event types a source is permitted to ASSERT. "Permitted to assert" is
 * NOT "Authority treats the assertion as verified" — every one of these 8
 * types remains exactly as ASSERTED_UNVERIFIED (I17) as it always was.
 *
 * ACTION_EXECUTED belongs here, and MUST stay here, even though this
 * codebase's own history is full of vulnerabilities that came from trusting
 * it (H2, reversed/padded authority_chain_ref, no envelope/payload identity
 * binding — see the earlier provenance investigation in this project).
 * Reclassifying it as "Authority-generated" would be dishonest: Authority
 * does not, and structurally cannot, generate ACTION_EXECUTED — a real
 * dispatch happens out in the world, outside Authority's control, and
 * Authority is only ever told about it afterwards. That is the textbook
 * definition of an externally-asserted fact. The actual lesson from every
 * ACTION_EXECUTED vulnerability was never "this event is misclassified" —
 * it was "an externally-asserted, unverified fact was allowed to drive an
 * internal accounting decision it should never have been trusted for" (the
 * EVIDENCE vs ACCOUNTING separation CAPABILITY_ISSUED/capacity.ts already
 * enacts instead). Classification (this file) and trust-for-accounting
 * (capacity.ts/grantValidation.ts) are two independent axes; conflating
 * them here would just move the same old mistake into a new file.
 */
export type ExternallyAssertedEventType = Exclude<AuthorityEventType, AuthorityGeneratedEventType>;

/** A draft narrowed to only the externally-assertable event types. */
export type ExternalDraftAuthorityEvent = Extract<DraftAuthorityEvent, { readonly event_type: ExternallyAssertedEventType }>;

/** A draft narrowed to only the Authority-generated event types. */
export type AuthorityGeneratedDraftEvent = Extract<DraftAuthorityEvent, { readonly event_type: AuthorityGeneratedEventType }>;
