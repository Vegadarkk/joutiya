import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { DoorMark } from "./door-mark";

interface EmptyStateProps {
  title: ReactNode;
  children?: ReactNode;
  /** The next step: an empty screen is an invitation to act. */
  action?: ReactNode;
  className?: string;
  headingLevel?: "h1" | "h2";
}

export function EmptyState({ title, children, action, className, headingLevel = "h2" }: EmptyStateProps) {
  const Heading = headingLevel;
  return (
    <section className={cn("mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-14 text-center", className)}>
      <DoorMark className="w-20" />
      <Heading className="text-xl font-semibold text-balance">{title}</Heading>
      {children ? <div className="text-foreground-muted text-pretty">{children}</div> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-3">{action}</div> : null}
    </section>
  );
}
