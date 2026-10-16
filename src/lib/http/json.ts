import type { z } from "@/lib/zod";
import { readCapped } from "./body";
import { HttpError } from "./errors";

// Request bodies (§6 "Injection NoSQL"): bounded read, JSON content type, Zod schema with
// `.strict()` objects (whitelisted fields). Nothing user-provided ever reaches a Firestore field name.

export const DEFAULT_MAX_BODY = 16 * 1024;

export async function readJson<T>(request: Request, schema: z.ZodType<T>, maxBytes = DEFAULT_MAX_BODY): Promise<T> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(type.trim())) throw new HttpError(415, "invalid_json", "expected application/json");
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) throw new HttpError(413, "payload_too_large");
  const text = await readCapped(request.body, maxBytes);
  if (text === null) throw new HttpError(413, "payload_too_large");
  let raw: unknown;
  try {
    raw = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Paths only: values never leave the server (passwords, e-mails).
    const details = parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), code: issue.code }));
    throw new HttpError(400, "invalid_body", undefined, { details });
  }
  return parsed.data;
}
