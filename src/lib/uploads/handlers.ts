import "server-only";
import { requireUser, type AuthContext } from "@/lib/auth/guards";
import { signUploadSchema, UPLOAD_ID_PATTERN, type SignUploadResponse, type UploadStatusResponse } from "@/lib/contracts/media";
import { notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { json, noContent } from "@/lib/http/route";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { z } from "@/lib/zod";
import { completeUpload, deleteUpload, signUpload, uploadStatus, type Uploader } from "./service";

// Route handlers of /api/uploads/** (design §3 MEDIA_API): thin, every one through requireUser
// (Origin + CSRF on mutations, 401 anonymous, 403 role_missing for an unactivated account, 403
// account_suspended), the ownership checks inside the service answering 404 (IDOR).

type Params = Promise<Record<string, string | string[] | undefined>>;

/** The complete call carries an empty JSON object (or no body at all). */
const completeSchema = z.object({}).strict();

async function uploadIdOf(params: Params): Promise<string> {
  const { id } = await params;
  if (typeof id !== "string" || !UPLOAD_ID_PATTERN.test(id)) throw notFound();
  return id;
}

function uploaderOf(request: Request, auth: AuthContext): Uploader {
  return { auth, ip: requestIdentity(request.headers).ip };
}

export async function handleSign(request: Request): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const input = await readJson(request, signUploadSchema);
  const body: SignUploadResponse = await signUpload(uploaderOf(request, auth), input);
  return json(body, { status: 201 });
}

export async function handleComplete(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  await enforceLimit("upload.status.uid", auth.user.uid);
  const id = await uploadIdOf(params);
  if (request.headers.get("content-type")) await readJson(request, completeSchema);
  const body: UploadStatusResponse = await completeUpload(uploaderOf(request, auth), id);
  return json(body);
}

export async function handleStatus(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request);
  await enforceLimit("upload.status.uid", auth.user.uid);
  const id = await uploadIdOf(params);
  const body: UploadStatusResponse = await uploadStatus(uploaderOf(request, auth), id);
  return json(body);
}

export async function handleDelete(request: Request, params: Params): Promise<Response> {
  const auth = await requireUser(request, { mutation: true });
  const id = await uploadIdOf(params);
  await deleteUpload(uploaderOf(request, auth), id);
  return noContent();
}
