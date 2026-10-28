import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { COMPOSE_ERROR_KEYS, composeErrorKey, composeProblem } from "@/components/listing/message-dialog";
import { canMessage } from "@/components/messages/can-message";
import { composerProblem, sendsOnEnter } from "@/components/messages/composer";
import { MESSAGING_ERROR_KEYS, messagingErrorKey } from "@/components/messages/errors";
import { formatDayLabel, formatRowTime } from "@/components/messages/format";
import { previewText, threadHref } from "@/components/messages/inbox";
import { firstPage, removeRow, shouldLoadMore, withFreshHead, withPage, withRow, type InboxList } from "@/components/messages/inbox-state";
import { canReport, MessageItem, textParts, warningsFor } from "@/components/messages/message-item";
import { badgeText } from "@/components/messages/messages-link";
import { selectedConversation } from "@/components/messages/messages-shell";
import { afterAction, stateChangeOf, type ThreadAction } from "@/components/messages/thread-actions";
import {
  canWrite,
  dayKey,
  fromNewestPage,
  groupByDay,
  lastMineStatus,
  pageCursorOf,
  withNewer,
  withOlderPage,
  withReadReceipt,
  withRefreshedPage,
} from "@/components/messages/thread-state";
import { prunePending } from "@/components/messages/thread-view";
import { ApiError } from "@/lib/auth/client";
import type { SessionSummary } from "@/lib/contracts/auth";
import { HIDDEN_MARKER, URL_MARKER, type ConversationView, type ConversationsPage, type MessagesPage, type MessageView } from "@/lib/contracts/messaging";

// The messaging pages' pure parts (design phase-5 D2-D9): inbox paging and live row updates, the
// thread's pages and read receipts, dates in Morocco's time zone, risk warnings and masked links,
// the composer and first-message checks, and the wording of every refusal in French and Arabic.

const cid = (n: number) => `c${String(n).padStart(21, "0")}`;

function row(n: number, updatedAt: number, patch: Partial<ConversationView> = {}): ConversationView {
  return {
    cid: cid(n),
    listingId: `listing${n}`,
    listingSlugId: `velo-listing${n}`,
    listing: { title: `Annonce ${n}`, price: 1000, isDonation: false, photo: null },
    role: "buyer",
    counterpart: { publicId: "abcdefghjk", displayName: "Salma" },
    lastMessage: { preview: "Bonjour", mine: false, at: updatedAt, flagged: false },
    unread: 0,
    archived: false,
    blockedByMe: false,
    blockedMe: false,
    frozen: false,
    counterpartClosed: false,
    review: { sellerRepliedAt: null, reviewedAt: null },
    updatedAt,
    ...patch,
  };
}

const list = (rows: ConversationView[], patch: Partial<InboxList> = {}): InboxList => ({ archived: false, rows, more: "idle", ...patch });
const page = (rows: ConversationView[], next?: string): ConversationsPage => ({ conversations: rows, ...(next ? { next } : {}) });
const cids = (state: { rows: ConversationView[] }) => state.rows.map((item) => item.cid);

function message(id: string, createdAt: number, patch: Partial<MessageView> = {}): MessageView {
  return { id, mine: false, type: "text", text: `texte ${id}`, flags: [], hidden: false, createdAt, readAt: null, ...patch };
}

function threadPage(messages: MessageView[], patch: Partial<MessagesPage> = {}): MessagesPage {
  // The wire order: newest first.
  return { conversation: row(1, 1), messages: [...messages].sort((a, b) => b.createdAt - a.createdAt), ...patch };
}

describe("inbox paging", () => {
  it("keeps the server order and only the rows of the view", () => {
    const state = firstPage(false, page([row(1, 10), row(2, 30), row(3, 20, { archived: true })], "n1"));
    expect(state.kind).toBe("ready");
    if (state.kind !== "ready") return;
    expect(cids(state)).toEqual([cid(2), cid(1)]);
    expect(state.next).toBe("n1");
    const archived = firstPage(true, page([row(3, 20, { archived: true }), row(4, 5)]));
    if (archived.kind === "ready") expect(cids(archived)).toEqual([cid(3)]);
  });

  it("goes on through short and empty pages while `next` is set", () => {
    // First page: nothing of this view, a cursor: load more without waiting for a scroll.
    let state = list([], { next: "n1" });
    expect(shouldLoadMore(state, false)).toBe(true);
    state = withPage({ ...state, more: "loading" }, page([], "n2"));
    expect(state.rows).toEqual([]);
    expect(shouldLoadMore(state, false)).toBe(true);
    state = withPage(state, page([row(5, 50)], "n3"));
    expect(cids(state)).toEqual([cid(5)]);
    // Rows on screen: the next page waits for the end of the list.
    expect(shouldLoadMore(state, false)).toBe(false);
    expect(shouldLoadMore(state, true)).toBe(true);
    expect(shouldLoadMore({ ...state, more: "loading" }, true)).toBe(false);
    expect(shouldLoadMore({ ...state, more: "failed" }, true)).toBe(false);
    state = withPage(state, page([row(6, 40)]));
    expect(cids(state)).toEqual([cid(5), cid(6)]);
    expect(state.next).toBeUndefined();
    expect(shouldLoadMore(state, true)).toBe(false);
  });

  it("keeps the fresher version of a row that moved between two pages", () => {
    const fresh = row(1, 90, { unread: 2 });
    let state = list([fresh, row(2, 50)], { next: "n1" });
    state = withPage(state, page([row(1, 10), row(3, 5)]));
    expect(cids(state)).toEqual([cid(1), cid(2), cid(3)]);
    expect(state.rows[0]?.unread).toBe(2);
  });

  it("replaces the head after a resync and keeps the rows loaded past it", () => {
    const loaded = list([row(1, 100), row(2, 90), row(3, 80), row(4, 70)], { next: "n-far" });
    // A new conversation on top; row 2 left the view; the head page ends at row 3.
    const state = withFreshHead(loaded, page([row(9, 200), row(1, 100), row(3, 80)], "n-head"));
    expect(cids(state)).toEqual([cid(9), cid(1), cid(3), cid(4)]);
    expect(state.next).toBe("n-far");
    // Nothing loaded past the head: the head's cursor.
    expect(withFreshHead(list([row(1, 100)], { next: "n1" }), page([row(1, 100)], "n-head")).next).toBe("n-head");
    // The whole list fits in the head.
    const all = withFreshHead(loaded, page([row(1, 100)]));
    expect(cids(all)).toEqual([cid(1)]);
    expect(all.next).toBeUndefined();
  });

  it("updates, inserts, moves and removes rows from live refetches", () => {
    const state = list([row(1, 100), row(2, 90), row(3, 80)], { next: "n1" });
    // A new message moves row 3 to the top.
    expect(cids(withRow(state, row(3, 300)))).toEqual([cid(3), cid(1), cid(2)]);
    // A new conversation inside the loaded range.
    expect(cids(withRow(state, row(7, 95)))).toEqual([cid(1), cid(7), cid(2), cid(3)]);
    // Older than everything loaded while more pages exist: its page will bring it.
    expect(withRow(state, row(8, 10))).toBe(state);
    // Everything loaded: it goes at the end.
    expect(cids(withRow({ ...state, next: undefined }, row(8, 10)))).toEqual([cid(1), cid(2), cid(3), cid(8)]);
    // Archived from another tab: it leaves the inbox.
    expect(cids(withRow(state, row(2, 90, { archived: true })))).toEqual([cid(1), cid(3)]);
    expect(cids(removeRow(state, cid(1)))).toEqual([cid(2), cid(3)]);
    expect(removeRow(state, cid(9))).toBe(state);
  });

  it("builds the row preview and the thread path", () => {
    const labels = { hidden: "Masqué", maskedLink: "[lien masqué]" };
    expect(previewText(row(1, 1, { lastMessage: { preview: `Voir ${URL_MARKER}\n merci`, mine: false, at: 1, flagged: true } }), labels)).toBe("Voir [lien masqué] merci");
    expect(previewText(row(1, 1, { lastMessage: { preview: HIDDEN_MARKER, mine: true, at: 1, flagged: false } }), labels)).toBe("Masqué");
    expect(threadHref(cid(1), false)).toBe(`/messages/${cid(1)}`);
    expect(threadHref(cid(1), true)).toBe(`/messages/${cid(1)}?archived=1`);
    expect(selectedConversation(cid(1))).toBe(cid(1));
    expect(selectedConversation(null)).toBeNull();
    expect(selectedConversation("__PAGE__")).toBeNull();
  });
});

describe("thread pages", () => {
  const newest = threadPage([message("m3", 30), message("m4", 40, { mine: true })], { next: "older-1", latest: "l4" });

  it("shows the newest page oldest first and prepends older pages", () => {
    let data = fromNewestPage(newest);
    expect(data.messages.map((item) => item.id)).toEqual(["m3", "m4"]);
    expect(data.older).toBe("older-1");
    data = withOlderPage(data, threadPage([message("m1", 10), message("m2", 20)]), "older-1");
    expect(data.messages.map((item) => item.id)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(data.older).toBeUndefined();
    expect(pageCursorOf(data, "m4")).toBeUndefined();
    expect(pageCursorOf(data, "m1")).toBe("older-1");
    expect(pageCursorOf(data, "zz")).toBeNull();
  });

  it("appends the messages after `latest` once, and replaces a page refetched after moderation", () => {
    let data = fromNewestPage(newest);
    data = withNewer(data, threadPage([message("m5", 50)], { latest: "l5" }));
    data = withNewer(data, threadPage([message("m5", 50)], { latest: "l5" }));
    expect(data.messages.map((item) => item.id)).toEqual(["m3", "m4", "m5"]);
    expect(data.latest).toBe("l5");
    expect(pageCursorOf(data, "m5")).toBeUndefined();
    // Nothing new: the cursor stays.
    expect(withNewer(data, threadPage([])).latest).toBe("l5");
    data = withRefreshedPage(data, threadPage([message("m3", 30, { hidden: true, text: HIDDEN_MARKER }), message("x9", 5)]));
    expect(data.messages.find((item) => item.id === "m3")?.hidden).toBe(true);
    // A refetched page never brings in messages that were not loaded.
    expect(data.messages.some((item) => item.id === "x9")).toBe(false);
  });

  it("marks my messages read up to the other side's receipt", () => {
    const data = fromNewestPage(threadPage([message("a", 10, { mine: true }), message("b", 20), message("c", 30, { mine: true }), message("d", 40, { mine: true })]));
    expect(lastMineStatus(data.messages)).toEqual({ id: "d", seen: false });
    const read = withReadReceipt(data, 30);
    expect(read.messages.filter((item) => item.readAt !== null).map((item) => item.id)).toEqual(["a", "c"]);
    expect(lastMineStatus(read.messages)).toEqual({ id: "d", seen: false });
    expect(lastMineStatus(withReadReceipt(read, 45).messages)).toEqual({ id: "d", seen: true });
    // Nothing to change: same object (no re-render).
    expect(withReadReceipt(read, 5)).toBe(read);
    expect(lastMineStatus([message("x", 1)])).toBeNull();
  });

  it("groups by day in Morocco's time zone", () => {
    // June 2026: UTC+1 in Casablanca (a past date: settled in the time zone data).
    const evening = Date.UTC(2026, 5, 14, 22, 30); // 23:30
    const midnight = Date.UTC(2026, 5, 14, 23, 30); // 00:30 the next day
    expect(dayKey(evening)).toBe("2026-06-14");
    expect(dayKey(midnight)).toBe("2026-06-15");
    const groups = groupByDay([message("a", evening), message("b", midnight), message("c", midnight + 60_000)]);
    expect(groups.map((group) => [group.day, group.messages.length])).toEqual([
      ["2026-06-14", 1],
      ["2026-06-15", 2],
    ]);
  });

  it("writes only in an open conversation of an active account", () => {
    const open = row(1, 1);
    expect(canWrite(open, false)).toBe(true);
    expect(canWrite(open, true)).toBe(false);
    for (const patch of [{ frozen: true }, { blockedByMe: true }, { blockedMe: true }, { counterpartClosed: true }]) expect(canWrite({ ...open, ...patch }, false)).toBe(false);
  });

  it("drops a sent bubble once the stored message is in the thread", () => {
    const pending = [{ localId: "l1", text: "a", createdAt: 1, messageId: "m1" }, { localId: "l2", text: "b", createdAt: 2 }];
    expect(prunePending(pending, [message("m1", 1)]).map((item) => item.localId)).toEqual(["l2"]);
    expect(prunePending(pending, [])).toHaveLength(2);
  });
});

describe("thread actions", () => {
  it("posts one state change per action and shows its result", () => {
    const changes: Record<ThreadAction, unknown> = { archive: { archived: true }, unarchive: { archived: false }, block: { blocked: true }, unblock: { blocked: false }, delete: { hidden: true } };
    for (const [action, change] of Object.entries(changes)) expect(stateChangeOf(action as ThreadAction)).toEqual(change);
    const conversation = row(1, 1, { unread: 3 });
    expect(afterAction(conversation, "archive").archived).toBe(true);
    expect(afterAction({ ...conversation, archived: true }, "unarchive").archived).toBe(false);
    expect(afterAction(conversation, "block").blockedByMe).toBe(true);
    expect(afterAction({ ...conversation, blockedByMe: true }, "unblock").blockedByMe).toBe(false);
  });
});

describe("dates", () => {
  const now = Date.UTC(2026, 5, 15, 10, 0); // Monday 15 June 2026, 11:00 in Casablanca (UTC+1)

  it("shows the time today, Hier, the weekday within a week, then the date", () => {
    expect(formatRowTime(Date.UTC(2026, 5, 15, 8, 5), now, "fr", "Hier")).toBe("09:05");
    expect(formatRowTime(Date.UTC(2026, 5, 14, 23, 30), now, "fr", "Hier")).toBe("00:30");
    expect(formatRowTime(Date.UTC(2026, 5, 14, 22, 30), now, "fr", "Hier")).toBe("Hier");
    expect(formatRowTime(Date.UTC(2026, 5, 12, 12, 0), now, "fr", "Hier")).toBe("ven.");
    expect(formatRowTime(Date.UTC(2026, 2, 9, 12, 0), now, "fr", "Hier")).toBe("9 mar.");
    expect(formatRowTime(Date.UTC(2025, 11, 30, 12, 0), now, "fr", "Hier")).toMatch(/30 déc\.? 2025/);
  });

  it("labels the thread's days", () => {
    const labels = { today: "Aujourd'hui", yesterday: "Hier" };
    expect(formatDayLabel(Date.UTC(2026, 5, 15, 9, 0), now, "fr", labels)).toBe("Aujourd'hui");
    expect(formatDayLabel(Date.UTC(2026, 5, 14, 9, 0), now, "fr", labels)).toBe("Hier");
    expect(formatDayLabel(Date.UTC(2026, 5, 8, 9, 0), now, "fr", labels)).toBe("lundi 8 juin");
    expect(formatDayLabel(Date.UTC(2025, 5, 8, 9, 0), now, "fr", labels)).toContain("2025");
  });
});

describe("messages", () => {
  it("warns the recipient only, most specific warning first", () => {
    expect(warningsFor({ mine: false, hidden: false, flags: ["external_url", "payment_kw", "iban"] })).toEqual(["payment_kw", "iban", "external_url"]);
    expect(warningsFor({ mine: false, hidden: false, flags: ["payment_kw", "contact_with_payment_kw"] })).toEqual(["contact_with_payment_kw"]);
    expect(warningsFor({ mine: true, hidden: false, flags: ["iban"] })).toEqual([]);
    expect(warningsFor({ mine: false, hidden: true, flags: ["iban"] })).toEqual([]);
  });

  it("splits the text around the masked links", () => {
    expect(textParts(`a ${URL_MARKER} b${URL_MARKER}`)).toEqual([
      { kind: "text", value: "a " },
      { kind: "link", value: URL_MARKER },
      { kind: "text", value: " b" },
      { kind: "link", value: URL_MARKER },
    ]);
    expect(textParts("plain")).toEqual([{ kind: "text", value: "plain" }]);
  });

  function render(item: MessageView, status?: "sent" | "seen" | "sending", locale: "fr" | "ar" = "fr") {
    return renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={locale === "fr" ? fr : ar} timeZone="Africa/Casablanca">
        <MessageItem message={item} time="10:00" sender="Salma" status={status} />
      </NextIntlClientProvider>,
    );
  }

  it("renders a moderated message as a placeholder, never its text", () => {
    const html = render(message("m1", 1, { hidden: true, text: HIDDEN_MARKER, flags: ["iban"] }));
    expect(html).toContain(fr.Messaging.thread.hidden);
    expect(html).not.toContain(HIDDEN_MARKER);
    expect(html).not.toContain('data-testid="risk-warning"');
  });

  it("renders masked links as chips and the safety warning under an incoming flagged message", () => {
    const html = render(message("m1", 1, { text: `Payez ici ${URL_MARKER}`, flags: ["external_url", "payment_kw"] }));
    expect(html).not.toContain(URL_MARKER);
    expect(html).toContain(fr.Messaging.thread.maskedLink);
    expect(html).toContain('data-testid="risk-warning"');
    expect(html).toContain(fr.Messaging.risk.payment_kw.replace(/'/g, "&#x27;"));
    expect(html).toContain('href="/fr/legal/confiance-et-securite"');
    const mine = render(message("m2", 1, { mine: true, text: `Payez ici ${URL_MARKER}`, flags: ["external_url"] }), "seen");
    expect(mine).not.toContain('data-testid="risk-warning"');
    expect(mine).toContain('data-testid="seen"');
    expect(mine).toContain('data-mine="true"');
  });

  it("offers to report an incoming text message only, when a handler is given", () => {
    expect(canReport(message("m1", 1))).toBe(true);
    expect(canReport(message("m1", 1, { mine: true }))).toBe(false);
    expect(canReport(message("m1", 1, { hidden: true, text: HIDDEN_MARKER }))).toBe(false);
    expect(canReport(message("m1", 1, { type: "system" }))).toBe(false);
    const withReport = renderToStaticMarkup(
      <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
        <MessageItem message={message("m1", 1)} time="10:00" sender="Salma" onReport={() => {}} />
      </NextIntlClientProvider>,
    );
    expect(withReport).toContain(`aria-label="${fr.Report.trigger.message}"`);
    expect(render(message("m1", 1))).not.toContain(`aria-label="${fr.Report.trigger.message}"`);
  });

  it("writes text in its own direction (Arabic interface, French message)", () => {
    const html = render(message("m1", 1, { text: "Bonjour, toujours disponible ?" }), undefined, "ar");
    expect(html).toContain('dir="auto"');
  });
});

describe("composer and first message", () => {
  it("refuses blank text and the reserved markers", () => {
    for (const check of [composerProblem, composeProblem]) {
      expect(check("   \n ")).toBe("empty");
      expect(check("voir ⟦url⟧")).toBe("reserved");
      expect(check(" Bonjour ")).toBeNull();
    }
  });

  it("sends on Enter with a fine pointer only, never Shift + Enter or while composing", () => {
    const key = (patch: Partial<Parameters<typeof sendsOnEnter>[0]> = {}) => ({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...patch });
    expect(sendsOnEnter(key(), true)).toBe(true);
    expect(sendsOnEnter(key(), false)).toBe(false);
    expect(sendsOnEnter(key({ ctrlKey: true }), false)).toBe(true);
    expect(sendsOnEnter(key({ shiftKey: true }), true)).toBe(false);
    expect(sendsOnEnter(key({ isComposing: true }), true)).toBe(false);
    expect(sendsOnEnter(key({ key: "a" }), true)).toBe(false);
  });

  it("maps the refusals to their own wording, in French and Arabic", () => {
    for (const key of COMPOSE_ERROR_KEYS) {
      expect(composeErrorKey(new ApiError(403, key)), key).toBe(key);
      expect(fr.ListingPage.contact.compose.errors[key], key).toBeTruthy();
      expect(ar.ListingPage.contact.compose.errors[key], key).toBeTruthy();
    }
    for (const key of MESSAGING_ERROR_KEYS) {
      expect(messagingErrorKey(new ApiError(400, key)), key).toBe(key);
      expect(fr.Messaging.errors[key], key).toBeTruthy();
      expect(ar.Messaging.errors[key], key).toBeTruthy();
    }
    // Shared codes keep the generic wording (Auth.errors), which knows them.
    for (const code of ["conversation_blocked", "conversation_unavailable", "self_conversation"] as const) {
      expect(messagingErrorKey(new ApiError(403, code))).toBeNull();
      expect(fr.Auth.errors[code]).toBeTruthy();
      expect(ar.Auth.errors[code]).toBeTruthy();
    }
    expect(composeErrorKey(new Error("boom"))).toBeNull();
  });
});

describe("badge and access", () => {
  it("caps the badge at 99+", () => {
    expect(badgeText(1)).toBe("1");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
  });

  it("gives messaging to individuals and Pros, not to staff", () => {
    const session = (role: SessionSummary["role"]) => ({ uid: "u", role }) as SessionSummary;
    expect(canMessage(session("individual"))).toBe(true);
    expect(canMessage(session("pro"))).toBe(true);
    for (const role of ["admin", "moderator", null] as const) expect(canMessage(session(role))).toBe(false);
    expect(canMessage(null)).toBe(false);
    expect(canMessage(undefined)).toBe(false);
  });
});
