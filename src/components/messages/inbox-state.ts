import type { ConversationsPage, ConversationView } from "@/lib/contracts/messaging";

// Pure state of the inbox list (design phase-5 D2): pages of GET /api/conversations merged by cid
// in the server's order (newest activity first), rows replaced or removed by live refetches. The
// archived view holds only archived rows, the inbox only the others.

export interface InboxList {
  archived: boolean;
  rows: ConversationView[];
  /** Cursor of the next page; absent once the end is reached. */
  next?: string;
  more: "idle" | "loading" | "failed";
}

export type InboxState = { kind: "loading"; archived: boolean } | { kind: "failed"; archived: boolean; error: unknown } | ({ kind: "ready" } & InboxList);

/** The server's order: updatedAt desc, then cid desc. */
export function compareRows(a: ConversationView, b: ConversationView): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  return a.cid < b.cid ? 1 : a.cid > b.cid ? -1 : 0;
}

const belongs = (list: Pick<InboxList, "archived">, row: ConversationView) => row.archived === list.archived;

/** The first page of a view. */
export function firstPage(archived: boolean, page: ConversationsPage): InboxState {
  return { kind: "ready", archived, rows: page.conversations.filter((row) => row.archived === archived).sort(compareRows), next: page.next, more: "idle" };
}

/**
 * A later page appended: a row already shown keeps the fresher of the two versions. A page may
 * hold no row of this view at all while `next` is set (the caller keeps paging).
 */
export function withPage(list: InboxList, page: ConversationsPage): InboxList {
  const byCid = new Map(list.rows.map((row) => [row.cid, row]));
  for (const row of page.conversations) {
    if (!belongs(list, row)) continue;
    const known = byCid.get(row.cid);
    if (!known || row.updatedAt >= known.updatedAt) byCid.set(row.cid, row);
  }
  return { ...list, rows: [...byCid.values()].sort(compareRows), next: page.next, more: "idle" };
}

/**
 * The first page fetched again (resync after a reconnection): it replaces the rows of its range;
 * rows older than its last one stay, with the cursor reached so far.
 */
export function withFreshHead(list: InboxList, page: ConversationsPage): InboxList {
  const head = page.conversations.filter((row) => belongs(list, row)).sort(compareRows);
  const oldest = page.conversations.length > 0 ? [...page.conversations].sort(compareRows).at(-1) : undefined;
  if (!page.next || !oldest) return { ...list, rows: head, next: page.next, more: "idle" };
  const fresh = new Set(head.map((row) => row.cid));
  const tail = list.rows.filter((row) => !fresh.has(row.cid) && compareRows(row, oldest) > 0);
  // Pages already loaded past the head keep their cursor; otherwise the head's own.
  return { ...list, rows: [...head, ...tail].sort(compareRows), next: tail.length > 0 ? list.next : page.next, more: "idle" };
}

/**
 * One row fetched again (live event, thread view): replaced, inserted when it falls inside the
 * loaded range (or everything is loaded), or removed when it left this view (archived, unarchived).
 */
export function withRow(list: InboxList, row: ConversationView): InboxList {
  if (!belongs(list, row)) return removeRow(list, row.cid);
  const index = list.rows.findIndex((item) => item.cid === row.cid);
  if (index === -1) {
    const last = list.rows.at(-1);
    if (list.next && last && compareRows(row, last) > 0) return list;
    return { ...list, rows: [...list.rows, row].sort(compareRows) };
  }
  const rows = [...list.rows];
  rows[index] = row;
  return { ...list, rows: rows.sort(compareRows) };
}

export function removeRow(list: InboxList, cid: string): InboxList {
  return list.rows.some((row) => row.cid === cid) ? { ...list, rows: list.rows.filter((row) => row.cid !== cid) } : list;
}

/** Load the next page now: the end of the list is on screen (or nothing of this view is shown yet). */
export function shouldLoadMore(list: InboxList, endVisible: boolean): boolean {
  return Boolean(list.next) && list.more === "idle" && (endVisible || list.rows.length === 0);
}
