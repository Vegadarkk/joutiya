import "server-only";

// Hiding a reported message belongs to the messaging lot (L1): `hideMessage(cid, mid, reason)`
// replaces the text by HIDDEN_MARKER and keeps the original in the evidence subcollection.
// Imported lazily: messaging imports this lot lazily too (system reports), no load-time cycle.
// Tests replace both through setMessageVisibility.

export type MessageHider = (cid: string, mid: string, reason: string) => Promise<boolean>;
export type MessageUnhider = (cid: string, mid: string) => Promise<boolean>;

let hider: MessageHider = async (cid, mid, reason) => {
  const { hideMessage } = await import("@/lib/messaging");
  return hideMessage(cid, mid, reason);
};
let unhider: MessageUnhider = async (cid, mid) => {
  const { unhideMessage } = await import("@/lib/messaging");
  return unhideMessage(cid, mid);
};

export function hideReportedMessage(cid: string, mid: string, reason: string): Promise<boolean> {
  return hider(cid, mid, reason);
}

export function unhideReportedMessage(cid: string, mid: string): Promise<boolean> {
  return unhider(cid, mid);
}

/** Wiring point (integration, tests): the messaging lot's functions. */
export function setMessageVisibility(next: { hide?: MessageHider; unhide?: MessageUnhider }): void {
  if (next.hide) hider = next.hide;
  if (next.unhide) unhider = next.unhide;
}
