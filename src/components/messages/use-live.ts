"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "@/i18n/navigation";
import { useSession } from "@/lib/auth/client";
import type { MessagingEvent } from "@/lib/contracts/messaging";
import { messagingLive, type LiveSnapshot } from "@/lib/messaging/live";
import { canMessage } from "./can-message";

export { canMessage };

// React side of the tab's live messaging client (lib/messaging/live.ts): the header badge and the
// messaging pages subscribe while mounted; the stream closes shortly after the last one leaves.

const IDLE: LiveSnapshot = { status: "idle", unread: null };

function subscribeSnapshot(onChange: () => void): () => void {
  return messagingLive().watch(onChange);
}

/** Stream status and badge total, without opening anything. */
export function useLiveSnapshot(): LiveSnapshot {
  return useSyncExternalStore(subscribeSnapshot, () => messagingLive().getSnapshot(), () => IDLE);
}

/**
 * Keeps the stream open while mounted (signed-in members only) and hands its events to `listener`.
 * A session found gone (revoked, expired) re-runs the page's guard.
 */
export function useMessagingStream(listener?: (event: MessagingEvent) => void): LiveSnapshot {
  const { session } = useSession();
  const uid = canMessage(session) ? session.uid : null;
  const router = useRouter();
  const latest = useRef(listener);
  useEffect(() => {
    latest.current = listener;
  });
  useEffect(() => {
    if (!uid) return;
    const live = messagingLive();
    const offSignedOut = live.onSignedOut(() => router.refresh());
    const unsubscribe = live.subscribe(uid, (event) => latest.current?.(event));
    return () => {
      unsubscribe();
      offSignedOut();
    };
  }, [uid, router]);
  return useLiveSnapshot();
}
