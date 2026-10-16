/** "ou" between the Google button and the e-mail form. */
export function OrDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4 text-sm text-foreground-muted" aria-hidden="true">
      <span className="h-px flex-1 bg-border" />
      {label}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
