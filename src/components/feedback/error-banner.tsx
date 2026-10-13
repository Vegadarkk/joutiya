import type { ReactNode } from "react";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

const TONES = {
  danger: { icon: CircleAlert, className: "border-danger/30 bg-danger-surface text-danger" },
  warning: { icon: TriangleAlert, className: "border-warning/30 bg-warning-surface text-warning" },
  info: { icon: Info, className: "border-border bg-surface-muted text-foreground" },
} as const;

interface BannerProps {
  tone?: keyof typeof TONES;
  title: ReactNode;
  children?: ReactNode;
  /** A recovery action (retry button, link). */
  action?: ReactNode;
  className?: string;
}

/** Page or section level message: what happened and what to do next. */
export function ErrorBanner({ tone = "danger", title, children, action, className }: BannerProps) {
  const { icon: Icon, className: toneClass } = TONES[tone];
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex gap-3 rounded-md border p-4", toneClass, className)}>
      <Icon className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-medium">{title}</p>
        {children ? <div className="text-sm text-foreground">{children}</div> : null}
        {action ? <div className="mt-2">{action}</div> : null}
      </div>
    </div>
  );
}
