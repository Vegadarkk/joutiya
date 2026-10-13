import { readFileSync } from "node:fs";
import { assertFails, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, collectionGroup, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";
import { afterAll, beforeAll, describe, it } from "vitest";

// Firestore rules deny every client request (§6). Run with `npm run test:rules` (emulator).

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-joutiya",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "config/legal"), { companyName: "Adark Prime" });
    await setDoc(doc(db, "users/alice"), { displayName: "Alice", role: "individual" });
    await setDoc(doc(db, "listings/l1"), { ownerUid: "alice", title: "Vélo", status: "published" });
    await setDoc(doc(db, "conversations/c1"), { participants: ["alice", "bob"] });
    await setDoc(doc(db, "conversations/c1/messages/m1"), { from: "alice", text: "Salam" });
  });
});

afterAll(async () => {
  await env.clearFirestore();
  await env.cleanup();
});

const PATHS = ["config/legal", "users/alice", "listings/l1", "conversations/c1", "conversations/c1/messages/m1"];

const contexts = () => ({
  visitor: env.unauthenticatedContext().firestore(),
  owner: env.authenticatedContext("alice", { email_verified: true }).firestore(),
  admin: env.authenticatedContext("root", { role: "admin", email_verified: true }).firestore(),
});

describe("firestore.rules", () => {
  for (const name of ["visitor", "owner", "admin"] as const) {
    describe(name, () => {
      it("cannot read any document, even its own", async () => {
        const db = contexts()[name];
        for (const path of PATHS) await assertFails(getDoc(doc(db, path)));
      });

      it("cannot list or query collections", async () => {
        const db = contexts()[name];
        await assertFails(getDocs(collection(db, "listings")));
        await assertFails(getDocs(collectionGroup(db, "messages")));
      });

      it("cannot create, update or delete", async () => {
        const db = contexts()[name];
        await assertFails(setDoc(doc(db, "listings/new"), { ownerUid: "alice", title: "x" }));
        await assertFails(updateDoc(doc(db, "users/alice"), { role: "admin" }));
        await assertFails(deleteDoc(doc(db, "listings/l1")));
        await assertFails(setDoc(doc(db, "config/legal"), { companyName: "x" }));
      });
    });
  }
});
