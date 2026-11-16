/**
 * Target adapters: how the lab asks a system under test for a decision.
 *
 * The lab sends every target the SAME neutral request (the question plus the
 * visible log prefix). It never sends the engine's expected answer. A target
 * answers allow/deny; the mapping to and from Authority's four outcomes is
 * explicit and lives here:
 *
 *   engine AUTHORIZED          -> ALLOW
 *   engine DENIED              -> DENY
 *   engine REQUIRES_APPROVAL   -> not comparable (INCONCLUSIVE)
 *   engine UNKNOWN             -> not comparable (INCONCLUSIVE)
 *   target answer other than a clean allow/deny, unreachable target,
 *   HTTP error, malformed body -> INCONCLUSIVE (never FAIL)
 */
import type { AuthorityDecision } from "../domain/types.js";
import type { Probe, Scenario, ScenarioEvent } from "./scenario.js";

export type BinaryDecision = "ALLOW" | "DENY";

export interface TargetRequest {
  readonly request: {
    readonly agent: string;
    readonly capability: string;
    readonly amount: { readonly value: number; readonly currency: string };
    readonly human_root: string;
    readonly at: string;
  };
  /** The log prefix visible to the question; each event carries a 1-based `sequence`. */
  readonly log: readonly (ScenarioEvent & { readonly sequence: number })[];
}

export function buildTargetRequest(scenario: Scenario, probe: Probe): TargetRequest {
  return {
    request: { agent: probe.agent, capability: probe.capability, amount: probe.amount, human_root: scenario.human_root, at: probe.at },
    log: scenario.events.slice(0, probe.after_event).map((e, i) => ({ ...e, sequence: i + 1 })),
  };
}

export function mapEngineDecision(d: AuthorityDecision): BinaryDecision | undefined {
  if (d.outcome === "AUTHORIZED") return "ALLOW";
  if (d.outcome === "DENIED") return "DENY";
  return undefined;
}

export interface Exchange {
  readonly http_status: number | null;
  /** Raw response body exactly as received (string), or null when there was none. */
  readonly response_body: string | null;
  readonly sent_body: unknown;
}

export type Observation =
  | { readonly status: "ok"; readonly decision: BinaryDecision; readonly target_reason: string | null; readonly exchange: Exchange }
  | { readonly status: "error"; readonly error: string; readonly exchange: Exchange };

export interface TargetDescriptor {
  /** "simulated": an in-process stand-in written by this project. "real-system": a third-party engine actually queried. */
  readonly kind: "simulated" | "real-system";
  readonly name: string;
  readonly details: Readonly<Record<string, string | null>>;
}

export interface TargetAdapter {
  readonly descriptor: TargetDescriptor;
  evaluate(req: TargetRequest): Promise<Observation>;
}

export interface HttpAdapterConfig {
  readonly descriptor: TargetDescriptor;
  readonly url: string;
  readonly timeoutMs?: number;
  readonly buildBody: (req: TargetRequest) => unknown;
  /** Returns the decision (+ optional reason) or undefined when the body does not contain a clean decision. */
  readonly parse: (body: unknown) => { decision: BinaryDecision; reason: string | null } | undefined;
}

/** Generic JSON-over-HTTP adapter (POST). Every failure becomes an `error` observation, never an exception. */
export function httpAdapter(cfg: HttpAdapterConfig): TargetAdapter {
  return {
    descriptor: cfg.descriptor,
    async evaluate(req) {
      const sent = cfg.buildBody(req);
      let status: number | null = null;
      let text: string | null = null;
      try {
        const res = await fetch(cfg.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sent),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 5000),
        });
        status = res.status;
        text = await res.text();
      } catch (err) {
        return { status: "error", error: `request failed: ${(err as Error).message}`, exchange: { http_status: status, response_body: text, sent_body: sent } };
      }
      const exchange: Exchange = { http_status: status, response_body: text, sent_body: sent };
      if (status !== 200) return { status: "error", error: `HTTP ${status}`, exchange };
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return { status: "error", error: "response body is not JSON", exchange };
      }
      const parsed = cfg.parse(json);
      if (parsed === undefined) return { status: "error", error: "response does not contain a clean allow/deny decision", exchange };
      return { status: "ok", decision: parsed.decision, target_reason: parsed.reason, exchange };
    },
  };
}
