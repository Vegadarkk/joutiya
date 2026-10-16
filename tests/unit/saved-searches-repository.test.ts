import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { describe, expect, it } from "vitest";
import { accountEndPath } from "@/lib/saved-searches/repository";

// The alerts job's account-boundary cursor (D19): startAfter/endAt take a document reference, so
// accountEndPath must name a document of the account whose id sorts after every auto-ID. The order
// on Firestore itself is covered by tests/api/alerts/alerts.test.ts.

describe("accountEndPath", () => {
  it("names a document of the account, after every auto-ID ([A-Za-z0-9]) by UTF-8 bytes", () => {
    const firestore = getFirestore(initializeApp({ projectId: "demo-joutiya" }, "account-end-path"));
    // doc() throws for a path that does not name a document (e.g. a trailing slash).
    const ref = firestore.doc(accountEndPath("uid123"));
    expect(ref.parent.id).toBe("savedSearches");
    expect(ref.parent.parent?.id).toBe("uid123");
    expect(ref.parent.parent?.parent.id).toBe("users");
    expect(Buffer.compare(Buffer.from(ref.id), Buffer.from("z".repeat(20)))).toBe(1);
  });
});
