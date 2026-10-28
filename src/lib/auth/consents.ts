import "server-only";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth/guards";
import { transfersConsentSchema, type ConsentsResponse } from "@/lib/contracts/auth";
import { updateTransfersConsent } from "@/lib/db/repositories/users";
import type { UserPrivateDoc } from "@/lib/db/schemas";
import { readJson } from "@/lib/http/json";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { transfersConsentVersion } from "./consent-version";
import { jsonResponse, withDevice } from "./respond";

// Express consent to the transfers outside Morocco (art. 44 loi 09-08, design D12). Sign-up
// records the current version (with "+wa" while WhatsApp is live, D24); a member whose stored version differs sees the blocking re-consent
// panel of the account pages ((account)/layout.tsx) and renews it here.

/** True when the account's transfers consent is not the current text (missing private document: nothing to renew). */
export function needsTransfersReconsent(account: Pick<UserPrivateDoc, "consents"> | null, current = transfersConsentVersion()): boolean {
  return account !== null && account.consents?.transfers?.version !== current;
}

/**
 * POST /api/auth/consents `{ transfers: true }`: only consents.transfers changes, the uid comes from
 * the session. A suspended member may renew it too: it opens nothing the suspension closes.
 */
export async function handleConsents(request: Request): Promise<Response> {
  const context = await requireUser(request, { mutation: true, allowSuspended: true });
  await readJson(request, transfersConsentSchema);
  const { uid } = context.user;
  await enforceLimit("consents.uid", uid);
  const now = new Date();
  const version = transfersConsentVersion();
  await updateTransfersConsent(uid, version, now);
  // The uid and the version are the proof: no IP, no e-mail in the entry.
  await audit({
    actorUid: uid,
    actorRole: context.user.claims.role ?? "individual",
    action: "consent.transfers",
    target: { type: "user", id: uid },
    automated: false,
    reason: `version ${version}`,
    at: now,
  });
  const body: ConsentsResponse = { status: "recorded", version };
  return withDevice(jsonResponse(body), request);
}
