import "server-only";
import { requireUser } from "@/lib/auth/guards";
import { profileSchema, type ProfileResponse } from "@/lib/contracts/auth";
import { updateDisplayName, updateLocale } from "@/lib/db/repositories/users";
import { auth } from "@/lib/firebase/admin";
import { readJson } from "@/lib/http/json";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { jsonResponse, withDevice } from "./respond";
import { sessionSummary } from "./summary";

// Profile settings of the signed-in person only: the uid comes from the session, never from the body.

export async function handleProfile(request: Request): Promise<Response> {
  const context = await requireUser(request, { mutation: true });
  const input = await readJson(request, profileSchema);
  const { uid } = context.user;
  await enforceLimit("account.mutation.uid", uid);
  if (input.displayName !== undefined) {
    await updateDisplayName(uid, input.displayName);
    await auth().updateUser(uid, { displayName: input.displayName });
  }
  if (input.locale !== undefined) await updateLocale(uid, input.locale);
  const body: ProfileResponse = { session: await sessionSummary(context.user) };
  return withDevice(jsonResponse(body), request);
}
