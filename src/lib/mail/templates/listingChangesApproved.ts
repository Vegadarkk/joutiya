import type { TemplateData } from "../types";
import { formatDate, formatDay, GREETING, renderLayout, type BuiltMail, type MailLocale, type TemplateContext } from "./layout";

// A moderator approved the held edit of a listing the owner had paused, or one past its expiry
// (design D9, D16): the changes are approved, the listing is not online. Paused: resumable from
// "Mes annonces" until its expiry. Expired: renewable for free until its purge date, then deleted.

type Status = TemplateData["listingChangesApproved"]["status"];

const COPY: Record<MailLocale, { subject: (title: string) => string; title: string; approved: (title: string) => string; next: Record<Status, (until: string) => string>; button: Record<Status, string> }> = {
  fr: {
    subject: (title) => `Les modifications de votre annonce « ${title} » sont validées`,
    title: "Modifications validées",
    approved: (title) => `Un modérateur a vérifié les modifications de votre annonce « ${title} » : elles sont validées.`,
    next: {
      paused: (until) => `Votre annonce reste en pause, comme vous l'aviez choisi : elle n'est pas visible sur Joutiya. Vous pouvez la remettre en ligne depuis « Mes annonces » jusqu'au ${until}.`,
      expired: (until) =>
        `Votre annonce a expiré : elle n'est pas visible sur Joutiya. Vous pouvez la renouveler gratuitement depuis « Mes annonces » jusqu'au ${until}. Après cette date, elle sera supprimée définitivement, avec ses photos.`,
    },
    button: { paused: "Remettre mon annonce en ligne", expired: "Renouveler mon annonce" },
  },
  ar: {
    subject: (title) => `تمت الموافقة على تعديلات إعلانك «${title}»`,
    title: "تمت الموافقة على التعديلات",
    approved: (title) => `راجع أحد المشرفين تعديلات إعلانك «${title}» ووافق عليها.`,
    next: {
      paused: (until) => `يبقى إعلانك موقوفًا مؤقتًا كما اخترت، ولا يظهر على Joutiya. يمكنك إعادة نشره من «إعلاناتي» حتى ${until}.`,
      expired: (until) => `انتهت مدة إعلانك، ولا يظهر على Joutiya. يمكنك تجديده مجانًا من «إعلاناتي» حتى ${until}. بعد هذا التاريخ سيُحذف نهائيًا مع صوره.`,
    },
    button: { paused: "إعادة نشر إعلاني", expired: "تجديد إعلاني" },
  },
};

export function listingChangesApproved(data: TemplateData["listingChangesApproved"], ctx: TemplateContext): BuiltMail {
  const copy = COPY[ctx.lang];
  // Paused: until its expiry (date and time, like the other expiry mails); expired: until the purge day.
  const until = data.status === "paused" ? formatDate(data.until, ctx.locale) : formatDay(data.until, ctx.locale);
  return renderLayout({
    lang: ctx.lang,
    siteUrl: ctx.siteUrl,
    subject: copy.subject(data.title),
    title: copy.title,
    greeting: GREETING[ctx.lang](data.displayName),
    paragraphs: [copy.approved(data.title), copy.next[data.status](until)],
    action: { label: copy.button[data.status], url: data.url },
  });
}
