import { DEFAULT_AI } from "@/config/ai";
import { cn } from "@/lib/utils";

interface RiskMeterProps {
  score: number;
  /** Score from which the pre-moderation holds a listing (config/ai risk.reviewAt). */
  threshold?: number;
  className?: string;
}

/** Risk score 0-100 against the review threshold (gold tick): how far past the line a listing is. */
export function RiskMeter({ score, threshold = DEFAULT_AI.risk.reviewAt, className }: RiskMeterProps) {
  const value = Math.max(0, Math.min(100, Math.round(score)));
  const over = value >= threshold;
  return (
    <div className={cn("flex items-center gap-2", className)} title={`Seuil de vérification : ${threshold}`}>
      <span className={cn("w-7 text-end text-sm font-semibold tabular-nums", over ? "text-warning" : "text-foreground")}>{value}</span>
      <div role="meter" aria-label="Score de risque" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} className="relative h-2 w-24 rounded-full bg-surface-muted ring-1 ring-border ring-inset">
        <div className={cn("h-full rounded-full", over ? "bg-primary" : "bg-structure/70")} style={{ width: `${value}%` }} />
        <div aria-hidden="true" className="absolute -top-1 h-4 w-0.5 rounded-full bg-featured" style={{ insetInlineStart: `calc(${threshold}% - 1px)` }} />
      </div>
    </div>
  );
}
