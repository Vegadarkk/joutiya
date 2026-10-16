import "server-only";
import { logger } from "@/lib/logging/logger";

// Hiding a reported message belongs to the messaging lot (L1): `hideMessage(cid, mid, reason)`
// replaces the text by HIDDEN_MARKER and keeps the original in the evidence subcollection.
// TODO(integration L1): replace both bodies by the calls below once src/lib/messaging exports them:
//   import { hideMessage, unhideMessage } from "@/lib/messaging";
//   return hideMessage(cid, mid, reason);   /   return unhideMessage(cid, mid);
// Until then the hide is not applied (logged): a strong signal on a message hides nothing.

export type MessageHider = (cid: string, mid: string, reason: string) => Promise<boolean>;
export type MessageUnhider = (cid: string, mid: string) => Promise<boolean>;

let hider: MessageHider = async (cid) => {
  logger.warn({ cid }, "reports: hideMessage is not wired yet (L1): message left visible");
  return false;
};
let unhider: MessageUnhider = async (cid) => {
  logger.warn({ cid }, "reports: unhideMessage is not wired yet (L1)");
  return false;
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
