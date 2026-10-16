import "server-only";
import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { serverEnv } from "@/lib/env";

// Admin SDK (§3): the only path to Firebase Auth and Firestore. Credentials come from
// GOOGLE_APPLICATION_CREDENTIALS (Workload Identity Federation config, no JSON key) or the local
// emulators (FIREBASE_AUTH_EMULATOR_HOST, FIRESTORE_EMULATOR_HOST, read by the SDK itself).
// Custom tokens are signed through IAM by FIREBASE_SERVICE_ACCOUNT (serviceAccountId): with
// applicationDefault() the SDK never signs locally, so the account must be named explicitly.

export function isEmulated(): boolean {
  const env = serverEnv();
  return Boolean(env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST);
}

/** True when Auth and Firestore can be reached: a project id plus credentials or the emulators. */
export function isFirebaseConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.FIREBASE_PROJECT_ID && (isEmulated() || env.GOOGLE_APPLICATION_CREDENTIALS));
}

/** @deprecated name kept for phase 1 callers; same check as isFirebaseConfigured. */
export const isFirestoreConfigured = isFirebaseConfigured;

function adminApp(): App {
  const existing = getApps()[0];
  if (existing) return existing;
  const env = serverEnv();
  if (!env.FIREBASE_PROJECT_ID) throw new Error("Firebase is not configured (FIREBASE_PROJECT_ID)");
  return initializeApp({
    projectId: env.FIREBASE_PROJECT_ID,
    ...(env.FIREBASE_SERVICE_ACCOUNT ? { serviceAccountId: env.FIREBASE_SERVICE_ACCOUNT } : {}),
    ...(isEmulated() ? {} : { credential: applicationDefault() }),
  });
}

// The standalone build evaluates this module once per server chunk (instrumentation, pages, API
// routes) while the SDK stays a process-wide singleton: a module-level cache would call
// `settings()` a second time on the same instance, which throws. The cache lives on globalThis.
const FIRESTORE_KEY = Symbol.for("joutiya.firestore");
type GlobalCache = typeof globalThis & { [FIRESTORE_KEY]?: Firestore };

let adminAuth: Auth | undefined;

export function db(): Firestore {
  const cache = globalThis as GlobalCache;
  if (!cache[FIRESTORE_KEY]) {
    const instance = getFirestore(adminApp());
    instance.settings({ ignoreUndefinedProperties: true });
    cache[FIRESTORE_KEY] = instance;
  }
  return cache[FIRESTORE_KEY];
}

export function auth(): Auth {
  adminAuth ??= getAuth(adminApp());
  return adminAuth;
}
