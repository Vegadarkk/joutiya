import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Staff withdrawal of a verified number (audit C1-02) against the Firebase emulators: number,
// date and badge leave the account, the reason is audited, the account view follows, and the
// route refuses members, empty reasons and accounts without a verified number.

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/alert", () => ({ alert: vi.fn(async () => true) }));
vi.mock("@/lib/rate-limit/limiter", { spy: true });

import { DELETE as revokeRoute } from "@/app/api/admin/users/[uid]/phone/route";
import { GET as userRoute } from "@/app/api/admin/users/[uid]/route";
import type { UserModerationView } from "@/lib/decisions/contracts";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import * as limiter from "@/lib/rate-limit/limiter";
import { freshPhone, member } from "../../listings/helpers";
import { adminCall, audits, privateAccount, staff, type Staff } from "./helpers";

let moderator: Staff;

beforeAll(async () => {
  resetServerEnv();
  moderator = await staff("moderator");
});

beforeEach(() => limiter.resetRateLimiters());

const badge = async (uid: string) => (await db().collection(COLLECTIONS.users).doc(uid).get()).get("badges.phoneVerified");

describe("phone badge withdrawal", () => {
  it("withdraws the number and the badge, audits the reason and updates the account view", async () => {
    const seller = await member({ phone: freshPhone() });
    const before = await adminCall<{ user: UserModerationView }>(userRoute, "GET", `/api/admin/users/${seller.uid}`, { as: moderator, params: { uid: seller.uid } });
    expect(before.body.user.phone).toEqual({ verified: true, verifiedAt: expect.any(String) });

    const path = `/api/admin/users/${seller.uid}/phone`;
    const revoked = await adminCall(revokeRoute, "DELETE", path, { as: moderator, params: { uid: seller.uid }, body: { reason: "Numéro utilisé pour une arnaque" } });
    expect(revoked.status).toBe(204);
    expect(await badge(seller.uid)).toBe(false);
    const account = await privateAccount(seller.uid);
    expect(account["phoneE164"]).toBeUndefined();
    expect(account["phoneVerifiedAt"]).toBeUndefined();
    expect(await audits("phone.revoked", seller.uid)).toEqual([expect.objectContaining({ actorUid: moderator.uid, actorRole: "moderator", reason: "Numéro utilisé pour une arnaque", automated: false })]);

    const after = await adminCall<{ user: UserModerationView }>(userRoute, "GET", `/api/admin/users/${seller.uid}`, { as: moderator, params: { uid: seller.uid } });
    expect(after.body.user.phone).toEqual({ verified: false, verifiedAt: null });

    const again = await adminCall<{ error: { code: string } }>(revokeRoute, "DELETE", path, { as: moderator, params: { uid: seller.uid }, body: { reason: "Deuxième fois" } });
    expect(again.status).toBe(409);
  });

  it("refuses an empty reason, an unknown account and a request without a staff session", async () => {
    const seller = await member({ phone: freshPhone() });
    const path = `/api/admin/users/${seller.uid}/phone`;
    expect((await adminCall(revokeRoute, "DELETE", path, { as: moderator, params: { uid: seller.uid }, body: { reason: " " } })).status).toBe(400);
    expect((await adminCall(revokeRoute, "DELETE", path, { params: { uid: seller.uid }, body: { reason: "Sans session" } })).status).toBe(401);
    expect((await adminCall(revokeRoute, "DELETE", "/api/admin/users/nobody-here/phone", { as: moderator, params: { uid: "nobody-here" }, body: { reason: "Compte inconnu" } })).status).toBe(409);
    expect(await badge(seller.uid)).toBe(true);
  });
});
