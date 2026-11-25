/**
 * The reference SDK and storage in tests/oracle/sdk and tests/oracle/storage must stay IDENTICAL to src/sdk and src/storage at
 * commit 56924b8 (main after O1, before O2-1), apart from the import-path rewrites (`../domain/` and `../engine/` now point to
 * `../../../src/...`). The SHA-256 of each file is pinned; the values were computed from `git show 56924b8:src/<dir>/<file>`
 * with those rewrites. Editing the oracle to make a test pass changes its hash and fails this test.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FROZEN: Record<string, string> = {
  "sdk/authority.ts": "0727be5cfda781164c92b5d149194821f68846b7d030254361aa6ffff500a242",
  "sdk/backend.ts": "ba9b8247ba9997d13fdd901df7fdd4e6cdedee172c86c82fc9dcee404660c48c",
  "sdk/clock.ts": "fa1d24c795cf2ecae1cb9aeee3efd17670ccbf82fc66c1b4de15c21747f42652",
  "sdk/events.ts": "96bc34c8de40b12f8c7dcc9ceb916baab9e961e32d50008d7e3be23d5cb26cf3",
  "sdk/index.ts": "fe1aaa0cc71819a7874cd6b70ff00d99f1ee856b8156ad944d949a42e8f686bd",
  "sdk/types.ts": "06bc5fb8a657ab3d1fcbf767f931aa25bf38cf997f1d21e62e920113560993ff",
  "storage/capabilityIssuanceTransaction.ts": "cbc78c321729c0f52b45705f59e0963ea7a3a9fc6478ab38035d0cbd62e6b420",
  "storage/capabilityRedemptionTransaction.ts": "ff51ac455ad0bb07eb8e8d8ccd622c3060ba7f68bb67424af946a5f89ab46777",
  "storage/eventStore.ts": "2b841c5dabe145125002cea6cac75c61b5bf79a1e821839c501472004b68fddc",
  "storage/postgresCapabilityIssuanceTransaction.ts": "d9c13db0f437a6d992267848714f4a8de113c2e51511a616eaa70f824e8e610c",
  "storage/postgresCapabilityRedemptionTransaction.ts": "28f1dc46c2eca3871334dfda8c9a49d751883127579bd3e0f32c63bdfa983f81",
  "storage/postgresEventStore.ts": "44a3a0cee27d674b54305f602ff8ae193dee8739f12bc9c44ae6d69e7381ca65",
  "storage/writeSurfaces.ts": "6cdccb9bcf2955600ad799a5f8f0d7b680cfc5df9714d07023e695d22d79ac46",
};

describe("the frozen reference SDK and storage", () => {
  it("contain exactly the pinned files, byte for byte", () => {
    const actual: string[] = [];
    for (const dir of ["sdk", "storage"]) for (const name of readdirSync(new URL(`../oracle/${dir}/`, import.meta.url))) actual.push(`${dir}/${name}`);
    expect(actual.sort()).toEqual(Object.keys(FROZEN).sort());
    for (const key of actual) {
      const sha = createHash("sha256").update(readFileSync(new URL(`../oracle/${key}`, import.meta.url))).digest("hex");
      expect({ key, sha }).toEqual({ key, sha: FROZEN[key] });
    }
  });
});
