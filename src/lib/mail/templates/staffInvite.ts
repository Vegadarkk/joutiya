import type { TemplateData } from "../types";
import { GREETING, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

type Role = TemplateData["staffInvite"]["role"];

const COPY: Record<MailLocale, { subject: string; title: string; roles: Record<Role, string>; body: (role: string) => string[]; button: string; notYou: string }> = {
  fr: {
    subject: "Invitation à rejoindre l'équipe Aalan",
    title: "Invitation à l'équipe Aalan",
    roles: { moderator: "modérateur·rice", admin: "administrateur·rice" },
    body: (role) => [
      `Tu es invité·e à rejoindre l'équipe Aalan en tant que ${role}. Accepte l'invitation pour activer ton accès au back-office.`,
      "L'accès passe par Cloudflare Access avec ton compte Google : la validation en deux étapes doit y être activée.",
    ],
    button: "Accepter l'invitation",
    notYou: "Si tu n'attendais pas cette invitation, ignore cet e-mail.",
  },
  ar: {
    subject: "دعوة للانضمام إلى فريق Aalan",
    title: "دعوة إلى فريق Aalan",
    roles: { moderator: "مشرف", admin: "مدير" },
    body: (role) => [
      `أنت مدعو للانضمام إلى فريق Aalan بصفة ${role}. اقبل الدعوة لتفعيل وصولك إلى لوحة الإدارة.`,
      "يتم الوصول عبر Cloudflare Access بحساب Google الخاص بك، ويجب تفعيل التحقق بخطوتين عليه.",
    ],
    button: "قبول الدعوة",
    notYou: "إذا لم تكن تتوقع هذه الدعوة، فتجاهل هذا البريد الإلكتروني.",
  },
};

export function staffInvite(data: TemplateData["staffInvite"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body(copy.roles[data.role] ?? data.role),
    action: { label: copy.button, url: data.actionUrl },
    closing: [copy.notYou],
  });
}
