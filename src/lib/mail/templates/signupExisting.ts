import type { TemplateData } from "../types";
import { GREETING, NOT_YOU, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// Sign-up attempt on an e-mail that already has an account (§6, no enumeration): the browser got
// the same answer as a new sign-up, the owner of the address learns what happened here.

const COPY: Record<MailLocale, { subject: string; title: string; body: string[]; button: string; reset: string }> = {
  fr: {
    subject: "Tu as déjà un compte Joutiya",
    title: "Ton compte existe déjà",
    body: [
      "Quelqu'un, sans doute toi, vient d'essayer de créer un compte Joutiya avec cette adresse e-mail. Elle est déjà associée à un compte : il suffit de te connecter pour continuer.",
      "Mot de passe oublié ? Tu peux en choisir un nouveau grâce au lien ci-dessous.",
    ],
    button: "Me connecter",
    reset: "Réinitialiser mon mot de passe :",
  },
  ar: {
    subject: "لديك حساب على Joutiya بالفعل",
    title: "حسابك موجود بالفعل",
    body: [
      "حاول شخص ما، وربما كنت أنت، إنشاء حساب على Joutiya بعنوان البريد الإلكتروني هذا. هذا العنوان مرتبط بحساب قائم: يكفي تسجيل الدخول للمتابعة.",
      "هل نسيت كلمة المرور؟ يمكنك اختيار كلمة مرور جديدة عبر الرابط أدناه.",
    ],
    button: "تسجيل الدخول",
    reset: "إعادة تعيين كلمة المرور:",
  },
};

export function signupExisting(data: TemplateData["signupExisting"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject,
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: copy.body,
    action: { label: copy.button, url: data.loginUrl },
    links: [{ label: copy.reset, url: data.resetUrl }],
    closing: [NOT_YOU[ctx.lang]],
  });
}
