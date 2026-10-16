import { HttpError } from "@/lib/http/errors";
import { checkPassword, type PasswordContext } from "./password-rules";

// Password policy (§6, PLAN "Validate passwords ourselves"): the rules live in password-rules.ts
// (shared with the browser hints); this module turns a refusal into the API error. Firebase's own
// policy errors are not mapped by the Admin SDK, so the check happens here, before any call.

export { checkPassword, type PasswordContext, type PasswordIssue } from "./password-rules";

/** 400 `weak_password` with the reason in `details` (no value ever leaves the server). */
export function assertPasswordPolicy(password: string, context: PasswordContext = {}): void {
  const issue = checkPassword(password, context);
  if (issue) throw new HttpError(400, "weak_password", undefined, { details: { reason: issue } });
}
