"use client";

import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatDateTime, slaState } from "../_lib/moderation-format";

/** Calls `onTick` with the current time every `intervalMs`; returns the stop function. */
export function startClock(onTick: (now: Date) => void, intervalMs: number): () => void {
  const timer = setInterval(() => onTick(new Date()), intervalMs);
  return () => clearInterval(timer);
}

/**
 * The current time, ticking every `intervalMs`. Starts at the server's render time so the first
 * client render matches the HTML, then follows the browser clock from the first tick.
 */
export function useNow(renderedAt: string, intervalMs = 15_000): Date {
  const [now, setNow] = useState(() => new Date(renderedAt));
  useEffect(() => startClock(setNow, intervalMs), [intervalMs]);
  return now;
}

const TONE = {
  danger: "bg-danger-surface text-danger",
  warning: "bg-warning-surface text-warning",
  neutral: "bg-surface-muted text-foreground-muted",
} as const;

interface SlaTimerProps {
  dueAt: string;
  now: Date;
  /** The delay the due date was set with (the tone turns amber in its last quarter). */
  windowMs: number;
  className?: string;
}

/** Time left before a due date, or how late it is; the exact due time in the tooltip. */
export function SlaTimer({ dueAt, now, windowMs, className }: SlaTimerProps) {
  const state = slaState(dueAt, now, windowMs);
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium whitespace-nowrap tabular-nums", TONE[state.tone], className)}>
      <Clock aria-hidden="true" className="size-3.5" />
      {/* The browser may know another offset for the staff time zone than the server: its own wins after hydration. */}
      <time dateTime={dueAt} title={`Échéance : ${formatDateTime(dueAt)}`} suppressHydrationWarning>
        {state.label}
      </time>
    </span>
  );
}

/** A timer that ticks on its own (pages whose order does not depend on the clock). */
export function LiveSlaTimer({ renderedAt, ...props }: Omit<SlaTimerProps, "now"> & { renderedAt: string }) {
  const now = useNow(renderedAt);
  return <SlaTimer now={now} {...props} />;
}
