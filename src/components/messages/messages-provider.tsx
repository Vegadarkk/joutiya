"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { ApiError } from "@/lib/auth/client";
import type { ConversationView, MessagingEvent } from "@/lib/contracts/messaging";
import { fetchConversation, fetchInbox } from "@/lib/messaging/client";
import type { LiveSnapshot } from "@/lib/messaging/live";
import { firstPage, removeRow, withFreshHead, withPage, withRow, type InboxState } from "./inbox-state";
import { useMessagingStream } from "./use-live";

// State shared by the messaging pages (layout of /messages): the inbox list of the current view
// (?archived=1), kept current by the live stream, and the hooks the thread uses to update its row.

export interface MessagesContextValue {
  archived: boolean;
  inbox: InboxState;
  live: LiveSnapshot;
  loadMore: () => void;
  retry: () => void;
  /** A fresher version of a row (the open thread's own reads and actions). */
  putRow: (row: ConversationView) => void;
  dropRow: (cid: string) => void;
}

const MessagesContext = createContext<MessagesContextValue | null>(null);

export function useMessages(): MessagesContextValue {
  const value = useContext(MessagesContext);
  if (!value) throw new Error("useMessages outside MessagesProvider");
  return value;
}

export function MessagesProvider({ children }: { children: ReactNode }) {
  const archived = useSearchParams().get("archived") === "1";
  const [inbox, setInbox] = useState<InboxState>({ kind: "loading", archived });
  const [attempt, setAttempt] = useState(0);
  // Read by the async callbacks below (the view and list may change while a request runs).
  const latest = useRef({ archived, inbox });
  useEffect(() => {
    latest.current = { archived, inbox };
  });

  useEffect(() => {
    let current = true;
    fetchInbox({ archived }).then(
      (page) => {
        if (current) setInbox(firstPage(archived, page));
      },
      (error: unknown) => {
        if (current) setInbox({ kind: "failed", archived, error });
      },
    );
    return () => {
      current = false;
    };
  }, [archived, attempt]);

  const loadMore = useCallback(() => {
    const state = latest.current.inbox;
    if (state.kind !== "ready" || !state.next || state.more === "loading") return;
    const cursor = state.next;
    const wanted = state.archived;
    const loading: InboxState = { ...state, more: "loading" };
    latest.current = { ...latest.current, inbox: loading };
    setInbox(loading);
    fetchInbox({ cursor, archived: wanted }).then(
      (page) => setInbox((now) => (now.kind === "ready" && now.archived === wanted && now.next === cursor ? { kind: "ready", ...withPage(now, page) } : now)),
      () => setInbox((now) => (now.kind === "ready" && now.archived === wanted && now.next === cursor ? { ...now, more: "failed" } : now)),
    );
  }, []);

  const retry = useCallback(() => {
    setInbox({ kind: "loading", archived: latest.current.archived });
    setAttempt((value) => value + 1);
  }, []);

  const putRow = useCallback((row: ConversationView) => {
    setInbox((state) => (state.kind === "ready" ? { kind: "ready", ...withRow(state, row) } : state));
  }, []);

  const dropRow = useCallback((cid: string) => {
    setInbox((state) => (state.kind === "ready" ? { kind: "ready", ...removeRow(state, cid) } : state));
  }, []);

  // One refetch per row at a time; an event arriving meanwhile asks for one more.
  const rowFetches = useRef(new Map<string, boolean>());
  const refreshRow = useCallback(
    (cid: string) => {
      const fetches = rowFetches.current;
      if (fetches.has(cid)) {
        fetches.set(cid, true);
        return;
      }
      fetches.set(cid, false);
      const run = (): void => {
        fetchConversation(cid).then(
          ({ conversation }) => putRow(conversation),
          (error: unknown) => {
            // Deleted for me (another tab) or no longer mine: it leaves the list.
            if (error instanceof ApiError && error.status === 404) dropRow(cid);
          },
        ).finally(() => {
          if (fetches.get(cid)) {
            fetches.set(cid, false);
            run();
          } else {
            fetches.delete(cid);
          }
        });
      };
      run();
    },
    [putRow, dropRow],
  );

  const reloadHead = useCallback(() => {
    const wanted = latest.current.archived;
    fetchInbox({ archived: wanted }).then(
      (page) =>
        setInbox((state) => {
          if (state.archived !== wanted) return state;
          return state.kind === "ready" ? { kind: "ready", ...withFreshHead(state, page) } : firstPage(wanted, page);
        }),
      () => undefined,
    );
  }, []);

  const onEvent = useCallback(
    (event: MessagingEvent) => {
      switch (event.type) {
        case "message":
        case "message_updated":
        case "conversation":
          refreshRow(event.cid);
          return;
        case "resync":
          reloadHead();
          return;
        default:
          return;
      }
    },
    [refreshRow, reloadHead],
  );
  const live = useMessagingStream(onEvent);

  const value = useMemo<MessagesContextValue>(
    // A view switch shows its skeleton until its first page arrives.
    () => ({ archived, inbox: inbox.archived === archived ? inbox : { kind: "loading", archived }, live, loadMore, retry, putRow, dropRow }),
    [archived, inbox, live, loadMore, retry, putRow, dropRow],
  );
  return <MessagesContext.Provider value={value}>{children}</MessagesContext.Provider>;
}
