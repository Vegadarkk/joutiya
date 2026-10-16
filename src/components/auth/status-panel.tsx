import type { ComponentType, ReactNode, SVGProps } from "react";
import { cn } from "@/lib/utils";

interface StatusPanelProps {
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Extra content under the text (a form, a badge). */
  extra?: ReactNode;
  headingLevel?: "h2" | "h3";
  className?: string;
}

/**
 * Outcome of a flow (mail sent, address confirmed, number verified): a cream arch, the brand's
 * doorway, with one icon, one title and the next step.
 */
export function StatusPanel({ icon: Icon, title, children, actions, extra, headingLevel = "h2", className }: StatusPanelProps) {
  const Heading = headingLevel;
  return (
    <section
      role="status"
      aria-live="polite"
      className={cn("arch flex flex-col items-center gap-4 rounded-b-lg bg-surface-brand px-6 pb-8 pt-12 text-center", className)}
    >
      <span className="flex size-14 items-center justify-center rounded-full bg-surface text-primary shadow-sm">
        <Icon className="size-7" aria-hidden="true" />
      </span>
      <Heading className="text-xl font-semibold text-balance">{title}</Heading>
      {children ? <div className="max-w-sm text-foreground-muted text-pretty">{children}</div> : null}
      {extra ? <div className="w-full max-w-sm text-start">{extra}</div> : null}
      {actions ? <div className="mt-2 flex flex-wrap justify-center gap-3">{actions}</div> : null}
    </section>
  );
}
