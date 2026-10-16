"use client";

import { useEffect, useRef, type ComponentType, type ReactNode, type SVGProps } from "react";
import { cn } from "@/lib/utils";

interface StatusPanelProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Extra content under the text (a form, a badge). */
  extra?: ReactNode;
  /** "h1" when the panel is the whole page (the wizard's result screen). */
  headingLevel?: "h1" | "h2" | "h3";
  /** Move focus to the title when the panel appears (default): the screen just changed. */
  autoFocus?: boolean;
  className?: string;
}

/**
 * Outcome of a flow (mail sent, address confirmed, number verified): a cream arch, the brand's
 * doorway, with one icon, one title and the next step. The panel replaces a form, so focus lands
 * on its title; only the message itself is a status region (the extra content and the actions are
 * ordinary interactive content).
 */
export function StatusPanel({ icon: Icon, title, children, actions, extra, headingLevel = "h2", autoFocus = true, className }: StatusPanelProps) {
  const Heading = headingLevel;
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (autoFocus) heading.current?.focus();
  }, [autoFocus]);
  return (
    <section className={cn("arch flex flex-col items-center gap-4 rounded-b-lg bg-surface-brand px-6 pb-8 pt-12 text-center", className)}>
      <div role="status" className="flex flex-col items-center gap-4">
        <span className="flex size-14 items-center justify-center rounded-full bg-surface text-primary shadow-sm">
          <Icon className="size-7" aria-hidden="true" />
        </span>
        <Heading ref={heading} tabIndex={-1} className="rounded-sm text-xl font-semibold text-balance outline-none focus-visible:ring-3 focus-visible:ring-ring/25">
          {title}
        </Heading>
        {children ? <div className="max-w-sm text-foreground-muted text-pretty">{children}</div> : null}
      </div>
      {extra ? <div className="w-full max-w-sm text-start">{extra}</div> : null}
      {actions ? <div className="mt-2 flex flex-wrap justify-center gap-3">{actions}</div> : null}
    </section>
  );
}
