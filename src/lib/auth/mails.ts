import "server-only";
import type { Locale } from "@/config/site";
import { sendMail } from "@/lib/mail";
import { pageUrl, resetActionUrl, verificationActionUrl } from "./links";

// The security mails of the auth flows. Every one of them has priority "security": it bypasses
// the suppression list and falls back to the second provider (src/lib/mail).

interface Recipient {
  email: string;
  displayName: string;
  locale: Locale;
}

const hourBucket = () => Math.floor(Date.now() / 3_600_000);

/** Verification link of a pending account; one mail per account and hour at most (queue dedupe). */
export async function sendVerificationMail(input: Recipient & { uid: string }): Promise<void> {
  const actionUrl = await verificationActionUrl(input.email, input.locale);
  await sendMail({
    template: "verifyEmail",
    locale: input.locale,
    to: input.email,
    data: { displayName: input.displayName, actionUrl },
    priority: "security",
    idempotencyKey: `verify-${input.uid}-${hourBucket()}`,
  });
}

/** Sign-up attempt on an e-mail that already has an account: the answer to the browser stays the same; one mail per account and hour at most. */
export async function sendSignupExistingMail(input: Recipient & { uid: string }): Promise<void> {
  await sendMail({
    template: "signupExisting",
    locale: input.locale,
    to: input.email,
    data: { displayName: input.displayName, loginUrl: pageUrl(input.locale, "connexion"), resetUrl: pageUrl(input.locale, "mot-de-passe-oublie") },
    priority: "security",
    idempotencyKey: `signup-existing-${input.uid}-${hourBucket()}`,
  });
}

export async function sendResetMail(input: Recipient): Promise<void> {
  const actionUrl = await resetActionUrl(input.email, input.locale);
  await sendMail({ template: "resetPassword", locale: input.locale, to: input.email, data: { displayName: input.displayName, actionUrl }, priority: "security" });
}

export async function sendPasswordChangedMail(input: Recipient): Promise<void> {
  await sendMail({
    template: "passwordChanged",
    locale: input.locale,
    to: input.email,
    data: { displayName: input.displayName, at: new Date().toISOString() },
    priority: "security",
  });
}
