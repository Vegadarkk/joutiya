import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Settings section (/parametres): title and purpose on the start side, the controls on the end side. */
export function Section({ id, title, body, children, className }: { id: string; title: string; body: string; children: ReactNode; className?: string }) {
  return (
    <section aria-labelledby={`${id}-title`} className={cn("grid gap-6 py-8 first:pt-0 last:pb-0 sm:grid-cols-[13rem_1fr]", className)}>
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          {title}
        </h2>
        <p className="text-sm text-foreground-muted text-pretty">{body}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}
