/**
 * Thin, deterministic identifier constructors for tests. No randomness, no
 * shared mutable counters across tests — every fixture names its own ids
 * explicitly so scenarios stay readable and reproducible (I2).
 */

import {
  actionId,
  approvalId,
  delegationId,
  eventId,
  principalId,
  recipientId,
  type ActionId,
  type ApprovalId,
  type DelegationId,
  type EventId,
  type PrincipalId,
  type RecipientId,
} from "../../src/domain/types.js";

export const principal = (name: string): PrincipalId => principalId(name);
export const delegation = (name: string): DelegationId => delegationId(name);
export const action = (name: string): ActionId => actionId(name);
export const approval = (name: string): ApprovalId => approvalId(name);
export const evt = (name: string): EventId => eventId(name);
export const recipient = (name: string): RecipientId => recipientId(name);
