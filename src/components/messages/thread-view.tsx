"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowLeft, CalendarPlus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { AppointmentCard } from "@/components/appointments/appointment-card";
import type { AppointmentDialogProps } from "@/components/appointments/appointment-dialog";
import { FormMessage } from "@/components/auth/form-message";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { EmptyState } from "@/components/feedback/empty-state";
import { loadWithRetry } from "@/components/layout/chunk-retry";
import type { ReportDialogProps } from "@/components/report/report-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Locale } from "@/config/site";
import { getPathname, Link, useRouter } from "@/i18n/navigation";
import { isApiError, refreshSession, useSession } from "@/lib/auth/client";
import { APPOINTMENT_KINDS, type AppointmentKind, type AppointmentResponse } from "@/lib/contracts/appointments";
import { URL_MARKER, type ConversationView, type MessageView } from "@/lib/contracts/messaging";
import { isActive } from "@/lib/appointments/rules";
import { isolate } from "@/lib/i18n/bidi";
import { formatPrice } from "@/lib/listings/client/format";
import { changeConversationState, fetchConversation, fetchThread, markConversationRead, sendMessage } from "@/lib/messaging/client";
import { messagingLive } from "@/lib/messaging/live";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { useMessagingErrorMessage } from "./errors";
import { formatClock, formatDayLabel } from "./format";
import { ListingDoor } from "./listing-door";
import { MessageItem } from "./message-item";
import { useMessages } from "./messages-provider";
import { ThreadActions, type ThreadAction } from "./thread-actions";
import {
  canWrite,
  fromNewestPage,
  groupByDay,
  lastMineStatus,
  pageCursorOf,
  withNewer,
  withOlderPage,
  withReadReceipt,
  withRefreshedPage,
  type ThreadData,
} from "./thread-state";
import { useMessagingStream } from "./use-live";

/** The notice form loads on demand; while its chunk cannot be downloaded nothing opens. */
const ReportDialog = dynamic(() => loadWithRetry<ReportDialogProps>(() => import("@/components/report/report-dialog").then((module) => module.ReportDialog), () => null)(), { ssr: false });

/** The slot picker loads on demand, like the notice form. */
const AppointmentDialog = dynamic(() => loadWithRetry<AppointmentDialogProps>(() => import("@/components/appointments/appointment-dialog").then((module) => module.AppointmentDialog), () => null)(), {
  ssr: false,
});

/** `?rdv={kind}` on the thread's URL opens the slot picker with that kind (Concession, Agence entry points). */
export function requestedKind(search: string): AppointmentKind | null {
  const kind = new URLSearchParams(search).get("rdv");
  return (APPOINTMENT_KINDS as readonly string[]).includes(kind ?? "") ? (kind as AppointmentKind) : null;
}

/** What the thread reports: the other participant (menu) or one message received. */
type ReportSubject = { kind: "user" } | { kind: "message"; message: MessageView };

// One conversation (design phase-5 D2-D9): its newest page, older pages on demand, live updates
// from the stream (a new message fetches only what follows `latest`), the read receipt while the
// thread is on screen, the composer, and the menu. Read-only when frozen, blocked either way, when
// the other account is closed (L7), or when my account is suspended (D9: it still reads). When the stream is down, the thread polls.

/** Polling period of an open thread while the live stream is not open (Valkey down, refused). */
export const POLL_MS = 15_000;

interface Pending {
  localId: string;
  text: string;
  createdAt: number;
  /** Set once the server took it; dropped when the thread holds the stored message. */
  messageId?: string;
}

type View =
  | { kind: "loading" }
  | { kind: "failed"; error: unknown }
  | { kind: "missing" }
  | { kind: "ready"; data: ThreadData; older: "idle" | "loading" | "failed"; pending: Pending[] };

/** Pending bubbles the thread does not show yet as stored messages. */
export function prunePending(pending: readonly Pending[], messages: readonly MessageView[]): Pending[] {
  const stored = new Set(messages.map((message) => message.id));
  return pending.filter((item) => !item.messageId || !stored.has(item.messageId));
}

function ThreadSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Skeleton className="h-12 w-10 rounded-t-full rounded-b-md" />
        <span className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
        </span>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-3 p-4">
        <Skeleton className="h-10 w-2/3 rounded-2xl" />
        <Skeleton className="ms-auto h-10 w-1/2 rounded-2xl" />
        <Skeleton className="h-14 w-3/5 rounded-2xl" />
      </div>
    </div>
  );
}

export function ThreadView({ cid }: { cid: string }) {
  const t = useTranslations("Messaging.thread");
  const appointmentText = useTranslations("Appointments");
  const card = useTranslations("ListingCard");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const errorMessage = useMessagingErrorMessage();
  const { session } = useSession();
  const suspended = session?.suspended === true;
  const { archived, putRow, dropRow } = useMessages();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [picker, setPicker] = useState<{ open: boolean; kind?: AppointmentKind } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const olderMark = useRef<HTMLDivElement>(null);

  // The view as async callbacks must see it (several requests may finish in any order).
  const current = useRef<View>(view);
  const update = useCallback((change: (view: View) => View) => {
    const next = change(current.current);
    if (next === current.current) return;
    current.current = next;
    setView(next);
  }, []);
  const updateData = useCallback(
    (change: (data: ThreadData) => ThreadData) =>
      update((state) => {
        if (state.kind !== "ready") return state;
        const data = change(state.data);
        return { ...state, data, pending: prunePending(state.pending, data.messages) };
      }),
    [update],
  );
  const missing = useCallback(() => {
    update(() => ({ kind: "missing" }));
    dropRow(cid);
  }, [update, dropRow, cid]);

  useEffect(() => {
    let active = true;
    fetchThread(cid).then(
      (page) => {
        if (!active) return;
        update(() => ({ kind: "ready", data: fromNewestPage(page), older: "idle", pending: [] }));
        putRow(page.conversation);
        // A link to the thread may ask for the slot picker once (`?rdv=visit`); the parameter then goes.
        const kind = requestedKind(window.location.search);
        if (kind) {
          const url = new URL(window.location.href);
          url.searchParams.delete("rdv");
          window.history.replaceState(window.history.state, "", url);
          if (canWrite(page.conversation, false)) setPicker({ open: true, kind });
        }
      },
      (error: unknown) => {
        if (!active) return;
        if (isApiError(error) && error.status === 404) missing();
        else update(() => ({ kind: "failed", error }));
      },
    );
    return () => {
      active = false;
    };
  }, [cid, attempt, update, putRow, missing]);

  // Newer messages: one request at a time, one more if asked meanwhile.
  const newer = useRef({ running: false, again: false });
  const fetchNewer = useCallback(async (): Promise<void> => {
    const state = newer.current;
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    try {
      do {
        state.again = false;
        const view = current.current;
        if (view.kind !== "ready") return;
        const latest = view.data.latest;
        try {
          const page = await fetchThread(cid, latest ? { after: latest } : {});
          if (!latest || page.gap) {
            // More than a page arrived meanwhile: start again from the newest page.
            const fresh = page.gap ? await fetchThread(cid) : page;
            updateData(() => fromNewestPage(fresh));
            putRow(fresh.conversation);
          } else {
            updateData((data) => withNewer(data, page));
            putRow(page.conversation);
          }
        } catch (error) {
          if (isApiError(error) && error.status === 404) missing();
          // Anything else: the next event or poll tries again.
          return;
        }
      } while (state.again);
    } finally {
      state.running = false;
    }
  }, [cid, updateData, putRow, missing]);

  const refreshConversation = useCallback(async () => {
    try {
      const { conversation } = await fetchConversation(cid);
      updateData((data) => ({ ...data, conversation }));
      putRow(conversation);
    } catch (error) {
      if (isApiError(error) && error.status === 404) missing();
    }
  }, [cid, updateData, putRow, missing]);

  const refreshMessage = useCallback(
    async (mid: string) => {
      const view = current.current;
      if (view.kind !== "ready") return;
      const cursor = pageCursorOf(view.data, mid);
      if (cursor === null) return;
      try {
        const page = await fetchThread(cid, cursor ? { cursor } : {});
        updateData((data) => withRefreshedPage(data, page));
      } catch {
        // The next reload shows it.
      }
    },
    [cid, updateData],
  );

  useMessagingStream((event) => {
    if (event.type === "ready" || event.type === "resync") {
      void fetchNewer();
      return;
    }
    if (!("cid" in event) || event.cid !== cid) return;
    if (event.type === "message") void fetchNewer();
    else if (event.type === "message_updated") void refreshMessage(event.mid);
    else if (event.type === "read") updateData((data) => withReadReceipt(data, event.at));
    else if (event.type === "conversation") void refreshConversation();
  });

  // Without the live stream, the open thread asks for what is new now and then.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState !== "visible" || messagingLive().getSnapshot().status === "open") return;
      void fetchNewer();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [fetchNewer]);

  // Read receipt while the thread is on screen (D7): my unread count of it goes to zero.
  const unread = view.kind === "ready" ? view.data.conversation.unread : 0;
  useEffect(() => {
    if (unread === 0) return;
    let sent = false;
    const send = () => {
      if (sent || document.visibilityState !== "visible") return;
      sent = true;
      markConversationRead(cid).then(
        () => {
          updateData((data) => ({ ...data, conversation: { ...data.conversation, unread: 0 } }));
          const view = current.current;
          if (view.kind === "ready") putRow(view.data.conversation);
          const live = messagingLive();
          // The stream brings the new badge total; without it, ask.
          if (live.getSnapshot().status !== "open") void live.refreshUnread();
        },
        () => {
          sent = false;
        },
      );
    };
    send();
    document.addEventListener("visibilitychange", send);
    return () => document.removeEventListener("visibilitychange", send);
  }, [unread, cid, updateData, putRow]);

  const loadOlder = useCallback(() => {
    const view = current.current;
    if (view.kind !== "ready" || !view.data.older || view.older === "loading") return;
    const cursor = view.data.older;
    update((state) => (state.kind === "ready" ? { ...state, older: "loading" } : state));
    fetchThread(cid, { cursor }).then(
      (page) => update((state) => (state.kind === "ready" && state.data.older === cursor ? { ...state, data: withOlderPage(state.data, page, cursor), older: "idle" } : state)),
      () => update((state) => (state.kind === "ready" ? { ...state, older: "failed" } : state)),
    );
  }, [cid, update]);

  // Older messages load when the top of the thread comes into view.
  const hasOlder = view.kind === "ready" && Boolean(view.data.older);
  useEffect(() => {
    const mark = olderMark.current;
    if (!hasOlder || !mark || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && current.current.kind === "ready" && current.current.older === "idle") loadOlder();
    }, { root: scroller.current, rootMargin: "300px 0px" });
    observer.observe(mark);
    return () => observer.disconnect();
  }, [hasOlder, loadOlder]);

  const scrollToEnd = () => {
    // The list is a reversed column: 0 is its end (the newest message).
    if (scroller.current) scroller.current.scrollTop = 0;
  };

  const counter = useRef(0);
  async function send(text: string): Promise<boolean> {
    counter.current += 1;
    const localId = `local-${counter.current}`;
    setSendError(null);
    update((state) => (state.kind === "ready" ? { ...state, pending: [...state.pending, { localId, text, createdAt: Date.now() }] } : state));
    scrollToEnd();
    try {
      const { messageId } = await sendMessage(cid, text);
      update((state) =>
        state.kind === "ready" ? { ...state, pending: prunePending(state.pending.map((item) => (item.localId === localId ? { ...item, messageId } : item)), state.data.messages) } : state,
      );
      await fetchNewer();
      return true;
    } catch (error) {
      update((state) => (state.kind === "ready" ? { ...state, pending: state.pending.filter((item) => item.localId !== localId) } : state));
      if (isApiError(error, "unauthenticated")) {
        await refreshSession();
        router.refresh();
      } else if (isApiError(error, "account_suspended")) {
        void refreshSession();
      } else if (isApiError(error, "conversation_blocked", "conversation_unavailable")) {
        void refreshConversation();
      } else if (isApiError(error) && error.status === 404) {
        missing();
      }
      setSendError(errorMessage(error));
      return false;
    }
  }

  function onAction(action: ThreadAction, conversation: ConversationView) {
    if (action === "delete") {
      dropRow(cid);
      router.replace(archived ? "/messages?archived=1" : "/messages");
      return;
    }
    updateData((data) => ({ ...data, conversation }));
    putRow(conversation);
  }

  const [report, setReport] = useState<{ subject: ReportSubject; open: boolean } | null>(null);

  function onAppointment(response: AppointmentResponse) {
    updateData((data) => ({ ...data, conversation: { ...data.conversation, appointment: response.appointment } }));
    const view = current.current;
    if (view.kind === "ready") putRow(view.data.conversation);
    void fetchNewer();
  }
  const [unblocking, setUnblocking] = useState(false);
  async function unblock(conversation: ConversationView) {
    setUnblocking(true);
    try {
      await changeConversationState(cid, { blocked: false });
      onAction("unblock", { ...conversation, blockedByMe: false });
    } catch (error) {
      setSendError(errorMessage(error));
    } finally {
      setUnblocking(false);
    }
  }

  const backHref = archived ? "/messages?archived=1" : "/messages";

  if (view.kind === "loading") return <ThreadSkeleton label={t("loading")} />;
  if (view.kind === "missing") {
    return (
      <div className="flex flex-1 items-center justify-center">
        <EmptyState
          title={t("missingTitle")}
          action={
            <Button asChild variant="outline">
              <Link href={backHref}>{t("back")}</Link>
            </Button>
          }
        >
          {t("missingBody")}
        </EmptyState>
      </div>
    );
  }
  if (view.kind === "failed") {
    return (
      <div className="p-4">
        <FormMessage
          error={view.error}
          title={t("loadFailedTitle")}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-sm:h-11"
              onClick={() => {
                update(() => ({ kind: "loading" }));
                setAttempt((value) => value + 1);
              }}
            >
              {t("retry")}
            </Button>
          }
        >
          {errorMessage(view.error)}
        </FormMessage>
      </div>
    );
  }

  const { data } = view;
  const conversation = data.conversation;
  const name = conversation.counterpart.displayName;
  const writable = canWrite(conversation, suspended);
  const listingHref = getPathname({ href: `/annonce/${conversation.listingSlugId}`, locale });
  const price = conversation.listing.isDonation ? card("donation") : conversation.listing.price === null ? card("toDiscuss") : formatPrice(conversation.listing.price, locale);
  const mine = lastMineStatus(data.messages);
  const pending = prunePending(view.pending, data.messages);
  const labels = { today: t("today"), yesterday: t("yesterday") };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="thread-view">
      <header className="flex items-center gap-2 border-b border-border px-2 py-2 sm:gap-3 sm:px-4 lg:px-5">
        <Button asChild variant="ghost" size="icon" className="lg:hidden">
          <Link href={backHref} aria-label={t("back")}>
            <ArrowLeft className="rtl:rotate-180" aria-hidden="true" />
          </Link>
        </Button>
        <a href={listingHref} aria-label={t("listing", { title: isolate(conversation.listing.title) })} className="shrink-0 rounded-t-full rounded-b-md">
          <ListingDoor conversation={conversation} size="md" />
        </a>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 dir="auto" className="truncate leading-snug font-semibold" data-testid="thread-counterpart">
            {name}
          </h2>
          <p className="flex min-w-0 items-baseline gap-2 text-sm text-foreground-muted">
            <a href={listingHref} dir="auto" className="min-w-0 truncate hover:text-foreground hover:underline">
              {conversation.listing.title}
            </a>
            <span className={cn("shrink-0 font-medium tabular-nums", conversation.listing.isDonation ? "text-success" : "text-foreground")}>{price}</span>
          </p>
        </div>
        <ThreadActions conversation={conversation} onDone={onAction} onReport={() => setReport({ subject: { kind: "user" }, open: true })} />
      </header>

      {suspended ? (
        <ErrorBanner tone="info" title={t("suspended")} className="mx-3 mt-3 lg:mx-5" />
      ) : conversation.counterpartClosed ? (
        <ErrorBanner tone="info" title={t("counterpartClosed", { name: isolate(name) })} className="mx-3 mt-3 lg:mx-5" />
      ) : conversation.frozen ? (
        <ErrorBanner tone="warning" title={t("frozen")} className="mx-3 mt-3 lg:mx-5" />
      ) : conversation.blockedByMe ? (
        <ErrorBanner
          tone="info"
          title={t("blockedByMe", { name: isolate(name) })}
          className="mx-3 mt-3 lg:mx-5"
          action={
            <Button type="button" variant="outline" size="sm" className="max-sm:h-11" loading={unblocking} onClick={() => void unblock(conversation)}>
              {t("unblock", { name: isolate(name) })}
            </Button>
          }
        />
      ) : conversation.blockedMe ? (
        <ErrorBanner tone="info" title={t("blockedMe")} className="mx-3 mt-3 lg:mx-5" />
      ) : null}

      {conversation.appointment ? (
        <AppointmentCard
          key={conversation.appointment.id}
          cid={cid}
          appointment={conversation.appointment}
          counterpartName={name}
          listingTitle={conversation.listing.title}
          writable={writable}
          now={now}
          onChange={onAppointment}
          onReschedule={() => setPicker({ open: true, kind: conversation.appointment?.kind })}
        />
      ) : null}

      <div ref={scroller} className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overscroll-contain" data-testid="thread">
        <div className="flex flex-col gap-2 px-3 py-4 sm:px-5 lg:px-8">
          {data.older ? (
            <div ref={olderMark} className="flex justify-center pb-2">
              <Button type="button" variant="ghost" size="sm" className="max-sm:h-11" loading={view.older === "loading"} onClick={loadOlder}>
                {t("older")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 pt-4 pb-6 text-center">
              <ListingDoor conversation={conversation} size="lg" />
              <p className="text-xs text-foreground-muted">{t("start")}</p>
              <a href={listingHref} dir="auto" className="max-w-xs font-medium text-balance hover:underline">
                {conversation.listing.title}
              </a>
            </div>
          )}
          {groupByDay(data.messages).map((group) => {
            const first = group.messages[0];
            const label = first ? formatDayLabel(first.createdAt, now, locale, labels) : group.day;
            return (
              <section key={group.day} aria-label={label} className="flex flex-col gap-2">
                <p className="sticky top-2 z-10 mx-auto my-2 w-fit rounded-full border border-border bg-surface/95 px-3 py-0.5 text-xs font-medium text-foreground-muted shadow-sm">{label}</p>
                <ol className="flex flex-col gap-2">
                  {group.messages.map((message) => (
                    <MessageItem
                      key={message.id}
                      message={message}
                      sender={message.mine ? t("mine") : name}
                      time={formatClock(message.createdAt, locale)}
                      status={mine?.id === message.id && pending.length === 0 ? (mine.seen ? "seen" : "sent") : undefined}
                      onReport={(item) => setReport({ subject: { kind: "message", message: item }, open: true })}
                    />
                  ))}
                </ol>
              </section>
            );
          })}
          {pending.length > 0 ? (
            <ol className="flex flex-col gap-2">
              {pending.map((item) => (
                <MessageItem
                  key={item.localId}
                  message={{ id: item.localId, mine: true, type: "text", text: item.text, flags: [], hidden: false, createdAt: item.createdAt, readAt: null }}
                  sender={t("mine")}
                  time={formatClock(item.createdAt, locale)}
                  status="sending"
                />
              ))}
            </ol>
          ) : null}
        </div>
      </div>

      {writable ? (
        <Composer
          onSend={send}
          error={sendError}
          onTyping={() => setSendError(null)}
          leading={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0 rounded-full text-foreground-muted hover:text-foreground"
              aria-label={appointmentText("propose")}
              title={appointmentText("propose")}
              data-testid="appointment-open"
              onClick={() => setPicker({ open: true, kind: conversation.appointment?.kind })}
            >
              <CalendarPlus aria-hidden="true" />
            </Button>
          }
        />
      ) : sendError ? <p className="px-4 pb-3 text-sm text-danger">{sendError}</p> : null}
      {picker ? (
        <AppointmentDialog
          cid={cid}
          open={picker.open}
          onOpenChange={(open) => setPicker((current) => (current ? { ...current, open } : current))}
          counterpartName={name}
          defaultKind={picker.kind}
          rescheduling={conversation.appointment ? isActive(conversation.appointment, now) : false}
          onDone={(response) => {
            onAppointment(response);
            toast.success(appointmentText("proposedToast", { name: isolate(name) }));
          }}
        />
      ) : null}
      {report ? (
        <ReportDialog
          // One form per subject: another message starts a new notice.
          key={report.subject.kind === "message" ? report.subject.message.id : "user"}
          open={report.open}
          onOpenChange={(open) => setReport((current) => (current ? { ...current, open } : current))}
          target={report.subject.kind === "message" ? { type: "message", id: `${cid}/${report.subject.message.id}` } : { type: "user", id: conversation.counterpart.publicId }}
          context={report.subject.kind === "message" ? "message" : "conversation"}
          subject={name}
          quote={report.subject.kind === "message" ? report.subject.message.text.replaceAll(URL_MARKER, `[${t("maskedLink")}]`) : undefined}
        />
      ) : null}
    </div>
  );
}
