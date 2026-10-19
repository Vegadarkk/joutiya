import { readFileSync } from "node:fs";
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc, where } from "firebase/firestore";
import { afterAll, beforeAll, describe, it } from "vitest";

// Firestore rules (§6, phase 5 design D2 revised 19 Oct): deny-all. The browser never reads or
// writes Firestore, its own conversations included (the API serves them, the event stream says when
// to refetch). Every client is refused everywhere: visitors, members (suspended or pro), shop
// members, staff and role-less tokens, by id, by query and for every write.
// Run with `npm run test:rules` (emulator).

let env: RulesTestEnvironment;

const at = (iso: string) => new Date(iso);

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-joutiya",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "config/legal"), { companyName: "Adark Prime" });
    await setDoc(doc(db, "users/alice"), { displayName: "Alice", role: "individual" });
    await setDoc(doc(db, "listings/l1"), { ownerUid: "alice", title: "Vélo", status: "published" });
    await setDoc(doc(db, "listingStats/l1"), { views: 0, favorites: 0, contacts: 0, phoneReveals: 0 });
    await setDoc(doc(db, "uploads/u1"), { ownerUid: "alice", targetId: "l1", status: "ready" });
    await setDoc(doc(db, "searchOutbox/l1"), { op: "upsert", version: 1 });
    await setDoc(doc(db, "contentOps/op1"), { uid: "alice", op: "listing.publish", contentRef: "listings/l1", ip: "41.250.1.2" });
    await setDoc(doc(db, "revealLogs/r1"), { viewerUid: "bob", listingId: "l1", ipPrefixHash: "h", deviceHash: "d" });
    await setDoc(doc(db, "moderationDecisions/d1"), { target: { type: "listing", id: "l1" }, affectedUid: "alice", action: "restrict_visibility" });
    await setDoc(doc(db, "system/backup"), { cursor: "2026-10-16" });
    await setDoc(doc(db, "userBlocks/alice"), { uids: ["mallory"] });
    await setDoc(doc(db, "reports/rep1"), { target: { type: "listing", id: "l1", ownerUid: "alice" }, reporter: { uid: "bob" }, status: "open" });
    await setDoc(doc(db, "aiDecisions/ai1"), { task: "listing_screen", target: { type: "listing", id: "l1" } });
    await setDoc(doc(db, "authorityRequests/ar1"), { authority: "Parquet", status: "open" });
    await setDoc(doc(db, "suspensions/alice"), { until: at("2026-11-01T00:00:00Z") });
    // c1: bob buys from alice (individual). c2: carol buys from dave's shop "shop9".
    await setDoc(doc(db, "conversations/c1"), { participants: ["bob", "alice"], buyerUid: "bob", sellerUid: "alice", updatedAt: at("2026-10-16T10:00:00Z") });
    await setDoc(doc(db, "conversations/c1/messages/m1"), { senderUid: "bob", participants: ["bob", "alice"], text: "Salam", createdAt: at("2026-10-16T10:00:00Z") });
    await setDoc(doc(db, "conversations/c1/evidence/m1"), { text: "original https://evil.example", reason: "masked" });
    await setDoc(doc(db, "conversations/c2"), { participants: ["carol", "dave"], buyerUid: "carol", sellerUid: "dave", sellerProId: "shop9", updatedAt: at("2026-10-16T11:00:00Z") });
    await setDoc(doc(db, "conversations/c2/messages/m2"), { senderUid: "carol", participants: ["carol", "dave"], sellerProId: "shop9", text: "Bonjour", createdAt: at("2026-10-16T11:00:00Z") });
  });
});

afterAll(async () => {
  await env.clearFirestore();
  await env.cleanup();
});

/** The emulator context's client. */
type Firestore = ReturnType<ReturnType<RulesTestEnvironment["unauthenticatedContext"]>["firestore"]>;

const token = (uid: string, claims: Record<string, unknown>) => env.authenticatedContext(uid, { email_verified: true, ...claims }).firestore();

const DOCUMENTS = [
  "config/legal",
  "users/alice",
  "listings/l1",
  "listingStats/l1",
  "uploads/u1",
  "searchOutbox/l1",
  "contentOps/op1",
  "revealLogs/r1",
  "moderationDecisions/d1",
  "system/backup",
  "userBlocks/alice",
  "reports/rep1",
  "aiDecisions/ai1",
  "authorityRequests/ar1",
  "suspensions/alice",
  "conversations/c1",
  "conversations/c1/messages/m1",
  "conversations/c1/evidence/m1",
  "conversations/c2",
  "conversations/c2/messages/m2",
];

const COLLECTIONS = ["listings", "users", "uploads", "searchOutbox", "contentOps", "revealLogs", "moderationDecisions", "listingStats", "system", "userBlocks", "reports", "aiDecisions", "authorityRequests", "suspensions", "conversations", "conversations/c1/messages", "conversations/c1/evidence"];

const CONTEXTS: Record<string, () => Firestore> = {
  visitor: () => env.unauthenticatedContext().firestore(),
  "participant (alice)": () => token("alice", { role: "individual" }),
  "participant (bob)": () => token("bob", { role: "individual" }),
  "suspended participant": () => token("alice", { role: "individual", st: "suspended" }),
  "pro participant": () => token("alice", { role: "pro", proId: "shop1" }),
  "shop member of shop9": () => token("erin", { role: "pro", proId: "shop9" }),
  "no role": () => token("alice", {}),
  moderator: () => token("alice", { role: "moderator" }),
  admin: () => token("root", { role: "admin" }),
};

for (const [name, make] of Object.entries(CONTEXTS)) {
  describe(name, () => {
    it("cannot read any document, its own conversation and messages included", async () => {
      const db = make();
      for (const path of DOCUMENTS) await assertFails(getDoc(doc(db, path)));
    });

    it("cannot list or query any collection, however constrained", async () => {
      const db = make();
      for (const path of COLLECTIONS) await assertFails(getDocs(collection(db, path)));
      // The queries of the former realtime inbox (participants, shop, page limits): denied too.
      await assertFails(getDocs(query(collection(db, "conversations"), where("participants", "array-contains", "alice"), orderBy("updatedAt", "desc"), limit(30))));
      await assertFails(getDocs(query(collection(db, "conversations"), where("participants", "array-contains", "bob"), orderBy("updatedAt", "desc"), limit(1))));
      await assertFails(getDocs(query(collection(db, "conversations"), where("sellerProId", "==", "shop9"), orderBy("updatedAt", "desc"), limit(30))));
      await assertFails(getDocs(query(collection(db, "conversations/c1/messages"), where("participants", "array-contains", "alice"), orderBy("createdAt", "desc"), limit(50))));
      await assertFails(getDocs(query(collection(db, "listings"), where("ownerUid", "==", "alice"))));
      await assertFails(getDocs(collectionGroup(db, "messages")));
      await assertFails(getDocs(query(collectionGroup(db, "messages"), where("participants", "array-contains", "alice"))));
      await assertFails(getDocs(collectionGroup(db, "evidence")));
    });

    it("cannot create, update or delete anything", async () => {
      const db = make();
      await assertFails(setDoc(doc(db, "conversations/c1/messages/m9"), { senderUid: "bob", participants: ["bob", "alice"], text: "x", createdAt: new Date() }));
      await assertFails(updateDoc(doc(db, "conversations/c1"), { unread: { bob: 0 } }));
      await assertFails(updateDoc(doc(db, "conversations/c1/messages/m1"), { readAt: new Date() }));
      await assertFails(deleteDoc(doc(db, "conversations/c1")));
      await assertFails(setDoc(doc(db, "conversations/c3"), { participants: ["bob", "alice"] }));
      await assertFails(setDoc(doc(db, "conversations/c1/evidence/m1"), { text: "x" }));
      await assertFails(setDoc(doc(db, "listings/new"), { ownerUid: "alice", title: "x" }));
      await assertFails(updateDoc(doc(db, "users/alice"), { role: "admin" }));
      await assertFails(deleteDoc(doc(db, "listings/l1")));
      await assertFails(setDoc(doc(db, "config/legal"), { companyName: "x" }));
      await assertFails(setDoc(doc(db, "reports/new"), { target: { type: "listing", id: "l1" } }));
      await assertFails(setDoc(doc(db, "userBlocks/alice"), { uids: [] }));
      await assertFails(setDoc(doc(db, "anything/new"), { x: 1 }));
    });
  });
}
