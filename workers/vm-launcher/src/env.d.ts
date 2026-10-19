// Minimal Workers runtime types used by the launcher (kept local: no extra dependency).

interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
}
