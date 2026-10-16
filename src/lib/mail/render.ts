import "server-only";
import { LOCALES } from "@/config/site";
import { serverEnv } from "@/lib/env";
import { mailLocale, type BuiltMail, type TemplateContext } from "./templates/layout";
import { listingApproved } from "./templates/listingApproved";
import { listingExpired } from "./templates/listingExpired";
import { listingExpiringSoon } from "./templates/listingExpiringSoon";
import { listingPendingReview } from "./templates/listingPendingReview";
import { listingPublished } from "./templates/listingPublished";
import { listingRejected } from "./templates/listingRejected";
import { passwordChanged } from "./templates/passwordChanged";
import { phoneRemoved } from "./templates/phoneRemoved";
import { phoneVerified } from "./templates/phoneVerified";
import { resetPassword } from "./templates/resetPassword";
import { signupExisting } from "./templates/signupExisting";
import { staffInvite } from "./templates/staffInvite";
import { verifyEmail } from "./templates/verifyEmail";
import type { RenderedMail, TemplateData, TemplateId, TemplateMail } from "./types";

type TemplateRenderer<T extends TemplateId> = (data: TemplateData[T], ctx: TemplateContext) => BuiltMail;

const TEMPLATES: { [T in TemplateId]: TemplateRenderer<T> } = {
  verifyEmail,
  resetPassword,
  signupExisting,
  passwordChanged,
  staffInvite,
  phoneVerified,
  phoneRemoved,
  listingPublished,
  listingPendingReview,
  listingRejected,
  listingApproved,
  listingExpiringSoon,
  listingExpired,
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === "string" && Object.hasOwn(TEMPLATES, value);
}

/** Structural check of a queued job payload before it is rendered (never trust the queue blindly). */
export function isTemplateMail(value: unknown): value is TemplateMail {
  if (!value || typeof value !== "object") return false;
  const mail = value as Partial<TemplateMail>;
  return (
    isTemplateId(mail.template) &&
    (LOCALES as readonly string[]).includes(String(mail.locale)) &&
    typeof mail.to === "string" &&
    mail.to.includes("@") &&
    mail.to.length <= 320 &&
    typeof mail.data === "object" &&
    mail.data !== null
  );
}

/** Renders a template in the recipient's locale (Arabic RTL, Tarifit falls back to French). */
export function renderMail(mail: TemplateMail): RenderedMail {
  const env = serverEnv();
  const render = TEMPLATES[mail.template] as TemplateRenderer<TemplateId>;
  const built = render(mail.data, { lang: mailLocale(mail.locale), locale: mail.locale, siteUrl: env.SITE_URL });
  return {
    from: env.MAIL_FROM,
    to: mail.to,
    subject: built.subject,
    text: built.text,
    html: built.html,
    ...(built.replyTo ? { replyTo: built.replyTo } : {}),
    tags: { template: mail.template, env: env.APP_ENV },
    meta: { template: mail.template, locale: mail.locale, data: mail.data },
  };
}
