/**
 * Declarative conformance scenarios (Authority Conformance Lab V0).
 *
 * A scenario is plain JSON: an ordered log of simplified delegation events plus
 * "probes" (authorization questions asked at a precise point in the log). It
 * contains NO expected decision. The expected decision is always computed by
 * the existing Authority engine (`authorityAt`, see expected.ts), so the
 * scenario file cannot drift from the engine's own semantics.
 *
 * Deliberately narrow V0 vocabulary: delegate / subdelegate / revoke, one
 * monetary limit per delegation, exact-match capabilities, no expiry, no
 * approvals. Anything outside it is rejected with a ScenarioError rather than
 * silently ignored.
 */

export const SCENARIO_SCHEMA = "authority-conformance-scenario/v0";

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

export interface Amount {
  readonly value: number;
  readonly currency: string;
}

interface EventBase {
  /** Trusted authority time of this event (ISO 8601 UTC, explicit, never read from a clock). */
  readonly at: string;
}

export interface DelegateEvent extends EventBase {
  readonly type: "delegate";
  readonly id: string;
  readonly grantor: string;
  readonly grantor_type: "HUMAN_ROOT";
  readonly grantee: string;
  readonly capabilities: readonly string[];
  readonly can_delegate: boolean;
  readonly limit: Amount;
}

export interface SubdelegateEvent extends EventBase {
  readonly type: "subdelegate";
  readonly id: string;
  readonly parent: string;
  readonly grantor: string;
  readonly grantee: string;
  readonly capabilities: readonly string[];
  readonly can_delegate: boolean;
  readonly limit: Amount;
}

export interface RevokeEvent extends EventBase {
  readonly type: "revoke";
  readonly target: string;
  readonly by: string;
}

export type ScenarioEvent = DelegateEvent | SubdelegateEvent | RevokeEvent;

export interface Probe {
  readonly probe_id: string;
  readonly description: string;
  /** The question sees the first `after_event` events of the log (== the engine's atSequence). */
  readonly after_event: number;
  /** Trusted authority time at which the question is asked. */
  readonly at: string;
  readonly agent: string;
  /** "resource.action", exact match. */
  readonly capability: string;
  readonly amount: Amount;
}

export interface Scenario {
  readonly schema: typeof SCENARIO_SCHEMA;
  readonly scenario_id: string;
  readonly title: string;
  readonly description: string;
  readonly human_root: string;
  readonly assumptions: readonly string[];
  readonly expected_policy: readonly string[];
  readonly denial_conditions: readonly string[];
  readonly limits: readonly string[];
  readonly events: readonly ScenarioEvent[];
  readonly probes: readonly Probe[];
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ScenarioError(`${where}: expected an object`);
  return v as Record<string, unknown>;
}
function str(o: Record<string, unknown>, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) throw new ScenarioError(`${where}.${k}: expected a non-empty string`);
  return v;
}
function bool(o: Record<string, unknown>, k: string, where: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new ScenarioError(`${where}.${k}: expected a boolean`);
  return v;
}
function strArray(o: Record<string, unknown>, k: string, where: string): string[] {
  const v = o[k];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || x.length === 0)) {
    throw new ScenarioError(`${where}.${k}: expected an array of non-empty strings`);
  }
  return v as string[];
}
function iso(o: Record<string, unknown>, k: string, where: string): string {
  const v = str(o, k, where);
  if (!ISO.test(v) || Number.isNaN(Date.parse(v))) throw new ScenarioError(`${where}.${k}: expected UTC ISO 8601 with milliseconds (YYYY-MM-DDTHH:mm:ss.sssZ)`);
  return v;
}
function amount(o: Record<string, unknown>, k: string, where: string): Amount {
  const a = obj(o[k], `${where}.${k}`);
  const value = a.value;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ScenarioError(`${where}.${k}.value: expected a non-negative integer (smallest-unit-free whole amount)`);
  }
  return { value, currency: str(a, "currency", `${where}.${k}`) };
}
function capString(s: string, where: string): string {
  if (!/^[^.\s]+\.[^.\s]+$/.test(s)) throw new ScenarioError(`${where}: capability must be "resource.action", got ${JSON.stringify(s)}`);
  return s;
}

export function parseScenario(raw: unknown): Scenario {
  const o = obj(raw, "scenario");
  if (o.schema !== SCENARIO_SCHEMA) throw new ScenarioError(`scenario.schema: expected ${JSON.stringify(SCENARIO_SCHEMA)}`);
  const events: ScenarioEvent[] = [];
  const evRaw = o.events;
  if (!Array.isArray(evRaw) || evRaw.length === 0) throw new ScenarioError("scenario.events: expected a non-empty array");
  let lastMs = -Infinity;
  evRaw.forEach((e, i) => {
    const where = `events[${i}]`;
    const eo = obj(e, where);
    const at = iso(eo, "at", where);
    if (Date.parse(at) < lastMs) throw new ScenarioError(`${where}.at: events must be in non-decreasing time order`);
    lastMs = Date.parse(at);
    const type = eo.type;
    if (type === "delegate") {
      if (eo.grantor_type !== "HUMAN_ROOT") throw new ScenarioError(`${where}.grantor_type: V0 supports only "HUMAN_ROOT" root delegations`);
      events.push({
        type, at, id: str(eo, "id", where), grantor: str(eo, "grantor", where), grantor_type: "HUMAN_ROOT",
        grantee: str(eo, "grantee", where),
        capabilities: strArray(eo, "capabilities", where).map((c) => capString(c, `${where}.capabilities`)),
        can_delegate: bool(eo, "can_delegate", where), limit: amount(eo, "limit", where),
      });
    } else if (type === "subdelegate") {
      events.push({
        type, at, id: str(eo, "id", where), parent: str(eo, "parent", where), grantor: str(eo, "grantor", where),
        grantee: str(eo, "grantee", where),
        capabilities: strArray(eo, "capabilities", where).map((c) => capString(c, `${where}.capabilities`)),
        can_delegate: bool(eo, "can_delegate", where), limit: amount(eo, "limit", where),
      });
    } else if (type === "revoke") {
      events.push({ type, at, target: str(eo, "target", where), by: str(eo, "by", where) });
    } else {
      throw new ScenarioError(`${where}.type: unsupported event type ${JSON.stringify(type)} (V0: delegate, subdelegate, revoke)`);
    }
  });
  const probesRaw = o.probes;
  if (!Array.isArray(probesRaw) || probesRaw.length === 0) throw new ScenarioError("scenario.probes: expected a non-empty array");
  const ids = new Set<string>();
  const probes: Probe[] = probesRaw.map((p, i) => {
    const where = `probes[${i}]`;
    const po = obj(p, where);
    const probe_id = str(po, "probe_id", where);
    if (ids.has(probe_id)) throw new ScenarioError(`${where}.probe_id: duplicate ${probe_id}`);
    ids.add(probe_id);
    const after = po.after_event;
    if (typeof after !== "number" || !Number.isInteger(after) || after < 1 || after > events.length) {
      throw new ScenarioError(`${where}.after_event: expected an integer in 1..${events.length}`);
    }
    const at = iso(po, "at", where);
    const lastEventMs = Date.parse((events[after - 1] as ScenarioEvent).at);
    if (Date.parse(at) < lastEventMs) throw new ScenarioError(`${where}.at: a question cannot be asked before the last event it sees`);
    return {
      probe_id, description: str(po, "description", where), after_event: after, at, agent: str(po, "agent", where),
      capability: capString(str(po, "capability", where), `${where}.capability`), amount: amount(po, "amount", where),
    };
  });
  return {
    schema: SCENARIO_SCHEMA,
    scenario_id: str(o, "scenario_id", "scenario"),
    title: str(o, "title", "scenario"),
    description: str(o, "description", "scenario"),
    human_root: str(o, "human_root", "scenario"),
    assumptions: strArray(o, "assumptions", "scenario"),
    expected_policy: strArray(o, "expected_policy", "scenario"),
    denial_conditions: strArray(o, "denial_conditions", "scenario"),
    limits: strArray(o, "limits", "scenario"),
    events,
    probes,
  };
}

export function parseScenarioJson(text: string, source: string): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ScenarioError(`${source}: invalid JSON (${(err as Error).message})`);
  }
  try {
    return parseScenario(raw);
  } catch (err) {
    throw new ScenarioError(`${source}: ${(err as Error).message}`);
  }
}
