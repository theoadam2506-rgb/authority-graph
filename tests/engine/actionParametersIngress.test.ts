import { describe, expect, it } from "vitest";
import { computeActionFingerprint, toDraft } from "../../src/domain/events.js";
import { nonMonetaryParameters } from "../../src/domain/types.js";
import { ingestAll } from "../../src/engine/ingest.js";
import { AGENT_A, PURCHASE_ORDER_CREATE, THEO, actionRequest, rootDelegation, sequentialClock } from "../fixtures/scenarios.js";

describe("action parameter ingress", () => {
  it("rejects an incomplete V2 request before it can poison later evaluation", () => {
    const root = toDraft(rootDelegation({ sequence: 1, id: "d-param-ingress", grantor: THEO, grantorType: "HUMAN_ROOT", grantee: AGENT_A, capabilities: [PURCHASE_ORDER_CREATE], canDelegate: false }));
    const malformed = toDraft(actionRequest({ sequence: 2, id: "a-param-ingress", requester: AGENT_A, delegationId: "d-param-ingress" }));
    const malformedParameters = { kind: "non_monetary", fingerprint_scheme_version: 2 };
    const hostile = {
      ...malformed,
      payload: { ...malformed.payload, parameters: malformedParameters },
    } as typeof malformed;
    const result = ingestAll([root, hostile], sequentialClock);
    expect(result.outcomes).toEqual([
      { accepted: true, sequence: 1 },
      { accepted: false, reasonCode: "MALFORMED_ACTION_PARAMETERS" },
    ]);
    expect(result.canonicalStore).toHaveLength(1);
    expect(() => computeActionFingerprint(PURCHASE_ORDER_CREATE, malformedParameters as never)).not.toThrow();
    expect(computeActionFingerprint(PURCHASE_ORDER_CREATE, nonMonetaryParameters())).toMatch(/^[0-9a-f]{64}$/);
  });
});
