import { readFileSync } from "node:fs";
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc, where, type Firestore } from "firebase/firestore";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Firestore rules (§6, phase 5 design D2): a member reads his own conversations and their messages
// through queries constrained on `participants` (or a shop's `sellerProId`, phase 7); everything
// else is denied to every client: other collections, other people's conversations, unconstrained
// queries, the evidence subcollection, staff and role-less tokens, and every write.
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
    // Phase 5 collections other than conversations: server only.
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

const member = (uid: string, claims: Record<string, unknown> = {}) => env.authenticatedContext(uid, { role: "individual", email_verified: true, ...claims }).firestore();

const inbox = (db: Firestore, uid: string) => query(collection(db, "conversations"), where("participants", "array-contains", uid), orderBy("updatedAt", "desc"), limit(30));
const thread = (db: Firestore, cid: string, uid: string) => query(collection(db, `conversations/${cid}/messages`), where("participants", "array-contains", uid), orderBy("createdAt", "desc"), limit(50));
const shopInbox = (db: Firestore, proId: string) => query(collection(db, "conversations"), where("sellerProId", "==", proId), orderBy("updatedAt", "desc"), limit(30));

const SERVER_ONLY = [
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
  "conversations/c1/evidence/m1",
];

describe("participants", () => {
  it("read their conversation and its messages, by id and with the constrained queries", async () => {
    for (const uid of ["alice", "bob"]) {
      const db = member(uid);
      await assertSucceeds(getDoc(doc(db, "conversations/c1")));
      await assertSucceeds(getDoc(doc(db, "conversations/c1/messages/m1")));
      await assertSucceeds(getDocs(inbox(db, uid)));
      await assertSucceeds(getDocs(thread(db, "c1", uid)));
    }
  });

  it("keep reading while suspended, and as a pro member", async () => {
    await assertSucceeds(getDoc(doc(member("alice", { st: "suspended" }), "conversations/c1")));
    await assertSucceeds(getDocs(inbox(member("alice", { role: "pro" }), "alice")));
  });

  it("cannot read someone else's conversation or messages", async () => {
    const db = member("alice");
    await assertFails(getDoc(doc(db, "conversations/c2")));
    await assertFails(getDoc(doc(db, "conversations/c2/messages/m2")));
    await assertFails(getDocs(inbox(db, "carol")));
    await assertFails(getDocs(thread(db, "c2", "carol")));
    // Constrained on her own uid the query is allowed, and finds nothing: no message leaks.
    expect((await assertSucceeds(getDocs(thread(db, "c2", "alice")))).size).toBe(0);
    expect((await assertSucceeds(getDocs(inbox(db, "alice")))).docs.map((item) => item.id)).toEqual(["c1"]);
  });

  it("cannot run unconstrained queries", async () => {
    const db = member("alice");
    await assertFails(getDocs(collection(db, "conversations")));
    await assertFails(getDocs(query(collection(db, "conversations"), orderBy("updatedAt", "desc"), limit(30))));
    await assertFails(getDocs(collection(db, "conversations/c1/messages")));
    await assertFails(getDocs(query(collection(db, "conversations/c1/messages"), orderBy("createdAt", "desc"), limit(50))));
    await assertFails(getDocs(query(collectionGroup(db, "messages"), where("participants", "array-contains", "alice"))));
  });

  it("never read the evidence of masked or hidden messages", async () => {
    const db = member("bob");
    await assertFails(getDoc(doc(db, "conversations/c1/evidence/m1")));
    await assertFails(getDocs(collection(db, "conversations/c1/evidence")));
  });

  it("cannot write anything, not even in their conversation", async () => {
    const db = member("bob");
    await assertFails(setDoc(doc(db, "conversations/c1/messages/m9"), { senderUid: "bob", participants: ["bob", "alice"], text: "x", createdAt: new Date() }));
    await assertFails(updateDoc(doc(db, "conversations/c1"), { unread: { bob: 0 } }));
    await assertFails(updateDoc(doc(db, "conversations/c1/messages/m1"), { readAt: new Date() }));
    await assertFails(deleteDoc(doc(db, "conversations/c1")));
    await assertFails(setDoc(doc(db, "conversations/c3"), { participants: ["bob", "alice"] }));
    await assertFails(setDoc(doc(db, "conversations/c1/evidence/m1"), { text: "x" }));
  });
});

describe("shop members (phase 7 shared inbox)", () => {
  it("read the shop's conversations through the sellerProId query", async () => {
    const db = member("erin", { role: "pro", proId: "shop9" });
    await assertSucceeds(getDoc(doc(db, "conversations/c2")));
    await assertSucceeds(getDocs(shopInbox(db, "shop9")));
    await assertSucceeds(getDocs(query(collection(db, "conversations/c2/messages"), where("sellerProId", "==", "shop9"), orderBy("createdAt", "desc"), limit(50))));
  });

  it("read nothing of another shop or of a non-shop conversation", async () => {
    const db = member("erin", { role: "pro", proId: "shop9" });
    await assertFails(getDoc(doc(db, "conversations/c1")));
    await assertFails(getDocs(shopInbox(db, "shop1")));
    await assertFails(getDocs(shopInbox(member("frank", { role: "pro", proId: "shop1" }), "shop9")));
  });
});

describe("tokens that read nothing", () => {
  const cases = {
    visitor: () => env.unauthenticatedContext().firestore(),
    "no role": () => env.authenticatedContext("alice", { email_verified: true }).firestore(),
    moderator: () => env.authenticatedContext("alice", { role: "moderator", email_verified: true }).firestore(),
    admin: () => env.authenticatedContext("alice", { role: "admin", email_verified: true }).firestore(),
  };

  for (const [name, make] of Object.entries(cases)) {
    it(`${name}: no conversation, even as a participant uid`, async () => {
      const db = make();
      await assertFails(getDoc(doc(db, "conversations/c1")));
      await assertFails(getDoc(doc(db, "conversations/c1/messages/m1")));
      await assertFails(getDocs(inbox(db, "alice")));
      await assertFails(getDocs(thread(db, "c1", "alice")));
    });
  }
});

describe("server-only collections", () => {
  const contexts = {
    visitor: () => env.unauthenticatedContext().firestore(),
    member: () => member("alice"),
    admin: () => env.authenticatedContext("root", { role: "admin", email_verified: true }).firestore(),
  };

  for (const [name, make] of Object.entries(contexts)) {
    describe(name, () => {
      it("cannot read any document, even its own", async () => {
        const db = make();
        for (const path of SERVER_ONLY) await assertFails(getDoc(doc(db, path)));
      });

      it("cannot list or query collections", async () => {
        const db = make();
        for (const name of ["listings", "users", "uploads", "searchOutbox", "contentOps", "revealLogs", "moderationDecisions", "listingStats", "system", "userBlocks", "reports", "aiDecisions", "authorityRequests", "suspensions"]) {
          await assertFails(getDocs(collection(db, name)));
        }
        await assertFails(getDocs(query(collection(db, "listings"), where("ownerUid", "==", "alice"))));
        await assertFails(getDocs(collectionGroup(db, "messages")));
        await assertFails(getDocs(collectionGroup(db, "evidence")));
      });

      it("cannot create, update or delete", async () => {
        const db = make();
        await assertFails(setDoc(doc(db, "listings/new"), { ownerUid: "alice", title: "x" }));
        await assertFails(updateDoc(doc(db, "users/alice"), { role: "admin" }));
        await assertFails(deleteDoc(doc(db, "listings/l1")));
        await assertFails(setDoc(doc(db, "config/legal"), { companyName: "x" }));
        await assertFails(setDoc(doc(db, "reports/new"), { target: { type: "listing", id: "l1" } }));
        await assertFails(setDoc(doc(db, "userBlocks/alice"), { uids: [] }));
      });
    });
  }
});
