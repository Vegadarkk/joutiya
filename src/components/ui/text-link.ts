import { cn } from "@/lib/utils";

// Text links share one hover language: the underline never pops in or out (text-decoration-line
// cannot transition), it changes colour and distance in 150 ms on the door curve. The link colour
// stays with the caller (text-link, or muted text that turns foreground on hover).

/** A standalone link (an action set in text): a soft underline that firms up and tightens on hover. */
export const textLinkClassName = cn(
  "underline decoration-current/40 underline-offset-4",
  "transition-[color,text-decoration-color,text-underline-offset] duration-150 ease-door",
  "hover:decoration-current hover:underline-offset-2",
);

/** A quiet link (breadcrumbs, footer, names): no underline until hover, then it fades in. */
export const quietLinkClassName = cn(
  "underline decoration-transparent underline-offset-2",
  "transition-[color,text-decoration-color] duration-150 ease-door",
  "hover:decoration-current",
);
