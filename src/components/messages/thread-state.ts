import type { ConversationView, MessagesPage, MessageView } from "@/lib/contracts/messaging";

// Pure state of an open thread (design phase-5 D2, D7): pages of GET .../messages (newest first on
// the wire) kept oldest first for display, older pages prepended, newer messages (`after=latest`)
// appended, a message updated by moderation replaced in place, and the other side's read receipt.

/** A loaded page: the cursor it was fetched with (none for the newest page) and its messages. */
export interface LoadedPage {
  cursor?: string;
  ids: string[];
}

export interface ThreadData {
  conversation: ConversationView;
  /** Oldest first. */
  messages: MessageView[];
  pages: LoadedPage[];
  /** Cursor of the next older page; absent at the beginning of the conversation. */
  older?: string;
  /** Position of the newest message, the next `after`. */
  latest?: string;
}

const byTime = (a: MessageView, b: MessageView) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function merge(current: readonly MessageView[], incoming: readonly MessageView[]): MessageView[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort(byTime);
}

/** The newest page, as first loaded (or reloaded after a gap). */
export function fromNewestPage(page: MessagesPage): ThreadData {
  return {
    conversation: page.conversation,
    messages: [...page.messages].sort(byTime),
    pages: [{ ids: page.messages.map((message) => message.id) }],
    older: page.next,
    latest: page.latest,
  };
}

/** An older page (fetched with `cursor`) prepended. */
export function withOlderPage(data: ThreadData, page: MessagesPage, cursor: string): ThreadData {
  return {
    ...data,
    conversation: page.conversation,
    messages: merge(data.messages, page.messages),
    pages: [...data.pages, { cursor, ids: page.messages.map((message) => message.id) }],
    older: page.next,
  };
}

/** Messages after `latest` appended (a `gap` page is the caller's cue to reload the newest page instead). */
export function withNewer(data: ThreadData, page: MessagesPage): ThreadData {
  const [head, ...rest] = data.pages;
  const ids = page.messages.map((message) => message.id);
  return {
    ...data,
    conversation: page.conversation,
    messages: merge(data.messages, page.messages),
    pages: [{ ...head, ids: [...ids, ...(head?.ids ?? [])] }, ...rest],
    latest: page.latest ?? data.latest,
  };
}

/** A page fetched again (a message hidden or restored): its messages replace the loaded ones. */
export function withRefreshedPage(data: ThreadData, page: MessagesPage): ThreadData {
  const known = new Set(data.messages.map((message) => message.id));
  const replacements = page.messages.filter((message) => known.has(message.id));
  return { ...data, conversation: page.conversation, messages: merge(data.messages, replacements) };
}

/** The cursor to fetch the page holding `mid` again: undefined for the newest page, null when not loaded. */
export function pageCursorOf(data: ThreadData, mid: string): string | undefined | null {
  const page = data.pages.find((loaded) => loaded.ids.includes(mid));
  return page ? page.cursor : null;
}

/** The other participant read the thread at `at`: my messages sent until then are read. */
export function withReadReceipt(data: ThreadData, at: number): ThreadData {
  let changed = false;
  const messages = data.messages.map((message) => {
    if (!message.mine || message.readAt !== null || message.createdAt > at) return message;
    changed = true;
    return { ...message, readAt: at };
  });
  return changed ? { ...data, messages } : data;
}

/** Time up to which the other side has read my messages (the receipt sits on the newest one read). */
export function seenUntil(messages: readonly MessageView[]): number | null {
  let until: number | null = null;
  for (const message of messages) {
    if (message.mine && message.readAt !== null) until = Math.max(until ?? 0, message.createdAt);
  }
  return until;
}

/** My newest message, with whether the other side read it. */
export function lastMineStatus(messages: readonly MessageView[]): { id: string; seen: boolean } | null {
  const until = seenUntil(messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.mine && message.type === "text") return { id: message.id, seen: until !== null && message.createdAt <= until };
  }
  return null;
}

/** Day key in Morocco's time zone ("2026-10-19"). */
export function dayKey(at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

/** Messages grouped by day, oldest first. */
export function groupByDay(messages: readonly MessageView[]): { day: string; messages: MessageView[] }[] {
  const groups: { day: string; messages: MessageView[] }[] = [];
  for (const message of messages) {
    const day = dayKey(message.createdAt);
    const last = groups.at(-1);
    if (last && last.day === day) last.messages.push(message);
    else groups.push({ day, messages: [message] });
  }
  return groups;
}

/** The thread can take a new message: not frozen, nobody blocked, the other account not closed, mine not suspended. */
export function canWrite(conversation: ConversationView, suspended: boolean): boolean {
  return !conversation.frozen && !conversation.blockedByMe && !conversation.blockedMe && !conversation.counterpartClosed && !suspended;
}
