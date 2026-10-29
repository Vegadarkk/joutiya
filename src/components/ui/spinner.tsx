import { KhatamLoader } from "./khatam-loader";

/** Busy mark inside buttons and status lines: the khatam at the text's size, in its colour. */
export function Spinner({ className }: { className?: string }) {
  return <KhatamLoader size="inline" tone="current" className={className} />;
}
