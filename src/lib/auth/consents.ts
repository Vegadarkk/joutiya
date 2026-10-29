import "server-only";
import { cguAccepted, cguEffectiveFor } from "@/config/legal-versions";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth/guards";
import { CGU_VERSION, consentsRequestSchema, type ConsentsResponse } from "@/lib/contracts/auth";
import { getUserPrivate, recordCguNotice, updateCguConsent, updateTransfersConsent } from "@/lib/db/repositories/users";
import type { UserPrivateDoc } from "@/lib/db/schemas";
import { readJson } from "@/lib/http/json";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { WHATSAPP_CONSENT_SUFFIX, transfersConsentVersion } from "./consent-version";
import { jsonResponse, withDevice } from "./respond";

// Express consent to the transfers outside Morocco (art. 44 loi 09-08, design D12). Sign-up
// records the current version (with "+wa" while WhatsApp is live, D24); a member whose stored version differs sees the blocking re-consent
// panel of the account pages ((account)/layout.tsx) and renews it here.

/**
 * True when the account's transfers consent is not the current text (missing private document:
 * nothing to renew). A consent to the WhatsApp text also covers the shorter list without Meta, so
 * WhatsApp going off (or a secret briefly missing) asks no one again.
 */
export function needsTransfersReconsent(account: Pick<UserPrivateDoc, "consents"> | null, current = transfersConsentVersion()): boolean {
  if (account === null) return false;
  const stored = account.consents?.transfers?.version;
  return stored !== current && stored !== `${current}${WHATSAPP_CONSENT_SUFFIX}`;
}

/**
 * `{ cguNotice: true }`: the change notice was shown to this member. The first notice of a version
 * is recorded (consents.cguNotice, CGU §22.1), later ones change nothing; the answer gives the day
 * the version applies to the member.
 */
async function cguNoticeShown(uid: string, now: Date): Promise<ConsentsResponse> {
  const account = await getUserPrivate(uid);
  const notice = account?.consents.cguNotice;
  const pending = account !== null && !cguAccepted(account.consents.cgu.version);
  if (pending && notice?.version !== CGU_VERSION) await recordCguNotice(uid, CGU_VERSION, now);
  const noticeAt = notice?.version === CGU_VERSION ? notice.at : pending ? now : null;
  return { status: "recorded", version: CGU_VERSION, effective: cguEffectiveFor(noticeAt, now) };
}

/**
 * POST /api/auth/consents `{ transfers: true }` (re-consent panel), `{ cgu: true }` (CGU change
 * notice acknowledged, D11) or `{ cguNotice: true }` (the notice shown): only that field changes,
 * the uid comes from the session. A suspended member may send them too: they open nothing the
 * suspension closes.
 */
export async function handleConsents(request: Request): Promise<Response> {
  const context = await requireUser(request, { mutation: true, allowSuspended: true });
  const choice = await readJson(request, consentsRequestSchema);
  const { uid } = context.user;
  await enforceLimit("consents.uid", uid);
  const now = new Date();
  if ("cguNotice" in choice) return withDevice(jsonResponse(await cguNoticeShown(uid, now)), request);
  const cgu = "cgu" in choice;
  const version = cgu ? CGU_VERSION : transfersConsentVersion();
  await (cgu ? updateCguConsent : updateTransfersConsent)(uid, version, now);
  // The uid and the version are the proof: no IP, no e-mail in the entry.
  await audit({
    actorUid: uid,
    actorRole: context.user.claims.role ?? "individual",
    action: cgu ? "consent.cgu" : "consent.transfers",
    target: { type: "user", id: uid },
    automated: false,
    reason: `version ${version}`,
    at: now,
  });
  const body: ConsentsResponse = { status: "recorded", version };
  return withDevice(jsonResponse(body), request);
}
