import "server-only";
import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { serverEnv } from "@/lib/env";

// Admin SDK (§3): the only path to Firestore. Credentials come from GOOGLE_APPLICATION_CREDENTIALS
// (Workload Identity Federation config, no JSON key) or the local emulator.

export function isFirestoreConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.NEXT_PUBLIC_FIREBASE_PROJECT_ID && (env.FIRESTORE_EMULATOR_HOST || env.GOOGLE_APPLICATION_CREDENTIALS));
}

function adminApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const env = serverEnv();
  if (!env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) throw new Error("Firestore is not configured (NEXT_PUBLIC_FIREBASE_PROJECT_ID)");
  return initializeApp({
    projectId: env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    ...(env.FIRESTORE_EMULATOR_HOST ? {} : { credential: applicationDefault() }),
  });
}

let firestore: Firestore | undefined;

export function db(): Firestore {
  if (!firestore) {
    firestore = getFirestore(adminApp());
    firestore.settings({ ignoreUndefinedProperties: true });
  }
  return firestore;
}
