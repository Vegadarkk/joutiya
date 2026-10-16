import type { ReactNode } from "react";
import { EyeOff, Flag, MessagesSquare } from "lucide-react";
import { useTranslations } from "next-intl";
import { DoorMark } from "@/components/feedback/door-mark";

interface AuthShellProps {
  title: string;
  lead?: string;
  children: ReactNode;
  /** Under the form: the link to the other flow ("Pas encore de compte ?"). */
  footer?: ReactNode;
}

/**
 * Frame of the sign-in, sign-up, reset and action pages. Desktop: the green panel of the door on
 * the start side (promise, three trust points, the door resting on the page's bottom edge) and the
 * form on the end side. Mobile: a thin brand strip, then the form.
 */
export function AuthShell({ title, lead, children, footer }: AuthShellProps) {
  const t = useTranslations("Auth.common");
  const points = [
    { icon: MessagesSquare, text: t("trust.messages") },
    { icon: EyeOff, text: t("trust.phone") },
    { icon: Flag, text: t("trust.report") },
  ];
  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      <aside className="bg-structure text-structure-foreground lg:flex lg:w-[42%] lg:max-w-xl lg:shrink-0 lg:flex-col lg:justify-between">
        <div className="flex items-center gap-4 px-4 py-3 sm:px-6 lg:hidden">
          <DoorMark className="w-7 shrink-0" />
          <p className="text-sm font-medium text-pretty">{t("brandPromise")}</p>
        </div>
        <div className="hidden lg:flex lg:flex-col lg:gap-10 lg:px-12 lg:pt-16">
          <p className="max-w-sm text-2xl font-medium leading-snug text-balance">{t("brandPromise")}</p>
          <ul className="flex max-w-sm flex-col gap-4 text-structure-foreground/85">
            {points.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3">
                <Icon className="mt-1 size-5 shrink-0 text-gold-300" aria-hidden="true" />
                <span className="text-pretty">{text}</span>
              </li>
            ))}
          </ul>
        </div>
        {/* The gold threshold of the door meets the bottom edge of the panel. */}
        <div className="hidden lg:flex lg:justify-center lg:px-12 lg:pt-10">
          {/* Same lighter frame in both themes (the mark's default frame would vanish on this green). */}
          <DoorMark className="-mb-1.5 w-60 [&>path:first-child]:fill-bab-500" />
        </div>
      </aside>
      <section className="flex flex-1 justify-center px-4 py-10 sm:px-6 lg:py-16">
        <div className="flex w-full max-w-md flex-col">
          <h1 className="text-2xl font-semibold text-balance">{title}</h1>
          {lead ? <p className="mt-2 text-foreground-muted text-pretty">{lead}</p> : null}
          <div className="mt-8">{children}</div>
          {footer ? <div className="mt-8 border-t border-border pt-6 text-sm text-foreground-muted">{footer}</div> : null}
        </div>
      </section>
    </div>
  );
}
