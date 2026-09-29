/**
 * Unit binding (I25) — canonical action fingerprint, byte-for-byte.
 *
 * The literal hashes below are the reference vectors published in
 * EVENT_MODEL.md. They were computed by an independent reference
 * implementation of the documented byte format (not by
 * `computeActionFingerprint`), so this file is what keeps the documentation
 * and the implementation from drifting apart again.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeActionFingerprint } from "../../src/domain/events.js";
import { capability, money, monetaryParameters, nonMonetaryParameters, recipientId } from "../../src/domain/types.js";

const US = "\u001f";
const PAYMENTS_TRANSFER = capability("payments", "transfer");
const alice = recipientId("alice");

describe("F1 — currency is part of the action fingerprint", () => {
  it("500 EUR and 500 USD produce different fingerprints; only currency differs", () => {
    const eur = computeActionFingerprint(PAYMENTS_TRANSFER, monetaryParameters(money(500, "EUR"), alice));
    const usd = computeActionFingerprint(PAYMENTS_TRANSFER, monetaryParameters(money(500, "USD"), alice));
    expect(eur).not.toBe(usd);
  });

  it("amount and recipient remain material (controls)", () => {
    const base = computeActionFingerprint(PAYMENTS_TRANSFER, monetaryParameters(money(500, "EUR"), alice));
    expect(computeActionFingerprint(PAYMENTS_TRANSFER, monetaryParameters(money(501, "EUR"), alice))).not.toBe(base);
    expect(computeActionFingerprint(PAYMENTS_TRANSFER, monetaryParameters(money(500, "EUR"), recipientId("bob")))).not.toBe(base);
  });

  it("currency is compared exactly: no case folding, no whitespace trimming", () => {
    const fp = (currency: string) => computeActionFingerprint(PAYMENTS_TRANSFER, monetaryParameters(money(500, currency), alice));
    expect(fp("EUR")).not.toBe(fp("eur"));
    expect(fp("EUR")).not.toBe(fp("EUR "));
  });
});

describe("F2 — documented serialization equals implementation serialization", () => {
  const vectors: ReadonlyArray<{ readonly name: string; readonly hash: string; readonly cap: ReturnType<typeof capability>; readonly params: Parameters<typeof computeActionFingerprint>[1] }> = [
    { name: "500 EUR to alice", hash: "939c6f0ad6939d0effe6d83bfe2a098522331dd178ca84ed052b0bd59e3d84d3", cap: PAYMENTS_TRANSFER, params: monetaryParameters(money(500, "EUR"), alice) },
    { name: "500 USD to alice", hash: "ba6fccd49fd79e72c3cc8b970d5a696ee72fa5c59faa8e9ce6e0a8beb0e6b51a", cap: PAYMENTS_TRANSFER, params: monetaryParameters(money(500, "USD"), alice) },
    { name: "non-monetary, recipient alice", hash: "248cd9639125e734200aa67b91159991befca29c1e16b8516525390de5b2c197", cap: PAYMENTS_TRANSFER, params: nonMonetaryParameters(alice) },
    { name: "500 EUR, no recipient", hash: "4f8673ca9ad14e8b7ffec7d7d9d861275b23eb7f4a37f12590f8ee8e20816aa1", cap: PAYMENTS_TRANSFER, params: monetaryParameters(money(500, "EUR")) },
    { name: "zero amount", hash: "b779e50c5a64bf0538e64e65075c7377bcfaf567a618896d70f00d34c5afc452", cap: PAYMENTS_TRANSFER, params: monetaryParameters(money(0, "EUR"), alice) },
    { name: "multi-byte currency (LEN counts UTF-8 bytes, not UTF-16 units)", hash: "6307876b866f5c5052b8b353f79de675bc759accac1029ef68cdd1b5d723a9ff", cap: PAYMENTS_TRANSFER, params: monetaryParameters(money(500, "É"), alice) },
    { name: "multi-byte resource, action and recipient", hash: "64f90e63b46dddddf514f97f447064663698e0773d483b60b3335dbb212405e3", cap: capability("paiements", "virement"), params: monetaryParameters(money(500, "EUR"), recipientId("zoé")) },
  ];

  for (const v of vectors) {
    it(`reference vector: ${v.name}`, () => {
      expect(computeActionFingerprint(v.cap, v.params)).toBe(v.hash);
    });
  }

  it("the documented byte string, hashed independently, equals the implementation", () => {
    const documented = [
      "resource=8:payments",
      "action=8:transfer",
      "amount=3:500",
      "currency=3:EUR",
      "recipient=5:alice",
    ].join(US);
    const independent = createHash("sha256").update(documented, "utf8").digest("hex");
    expect(computeActionFingerprint(PAYMENTS_TRANSFER, monetaryParameters(money(500, "EUR"), alice))).toBe(independent);
  });
});

describe("F3 — fields containing U+001F cannot shift segment boundaries", () => {
  it("premise: an unprefixed labelled serialization WOULD collide on these two tuples", () => {
    const naive = (currency: string, recipient: string | undefined): string =>
      ["resource=payments", "action=transfer", "amount=500", `currency=${currency}`, `recipient=${recipient ?? "∅"}`].join(US);
    expect(naive(`EUR${US}recipient=x`, undefined)).toBe(naive("EUR", `x${US}recipient=∅`));
  });

  it("currency vs recipient: two different tuples that collide under an unprefixed serialization stay distinct", () => {
    const a = computeActionFingerprint(PAYMENTS_TRANSFER, monetaryParameters(money(500, `EUR${US}recipient=x`)));
    const b = computeActionFingerprint(PAYMENTS_TRANSFER, monetaryParameters(money(500, "EUR"), recipientId(`x${US}recipient=∅`)));
    expect(a).not.toBe(b);
  });

  it("resource vs action", () => {
    const a = computeActionFingerprint(capability(`p${US}action=q`, "r"), nonMonetaryParameters());
    const b = computeActionFingerprint(capability("p", `q${US}action=r`), nonMonetaryParameters());
    expect(a).not.toBe(b);
  });

  it("the absent marker cannot be forged by a present value", () => {
    const absent = computeActionFingerprint(PAYMENTS_TRANSFER, nonMonetaryParameters());
    const forged = computeActionFingerprint(PAYMENTS_TRANSFER, nonMonetaryParameters(recipientId("∅")));
    expect(absent).not.toBe(forged);
  });
});
