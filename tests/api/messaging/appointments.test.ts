import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Quota from "@/lib/quota";
import type * as Turnstile from "@/lib/security/turnstile";

vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/quota", async (importOriginal) => ({ ...(await importOriginal<typeof Quota>()), firstDegraded: vi.fn(async () => null), isDegraded: vi.fn(async () => false) }));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({
  ...(await importOriginal<typeof Turnstile>()),
  verifyTurnstile: vi.fn(async () => ({ ok: true, codes: [] })),
}));

import { POST as appointmentRoute } from "@/app/api/conversations/[cid]/appointment/route";
import { listDueReminders } from "@/lib/appointments/reminders";
import { MESSAGING_API } from "@/lib/contracts/endpoints";
import type { AppointmentResponse } from "@/lib/contracts/appointments";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { sendMail } from "@/lib/mail";
import { freezeConversation, hideMessage, unhideMessage } from "@/lib/messaging";
import { setEventPublisherForTests, type Delivery } from "@/lib/messaging/events";
import { getConversation } from "@/lib/messaging/repository";
import { setMessagingValkeyForTests } from "@/lib/messaging/unread";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { resolveReportTarget } from "@/lib/reports/targets";
import { sendAppointmentReminders } from "@/worker/jobs/appointment-reminders";
import { FakeValkey } from "../../unit/messaging-fake-valkey";
import { call, type CallResult } from "../favorites/helpers";
import { expectError, member, seedListing, setState, startOk, thread, type ErrorBody, type Member } from "./helpers";

// POST /api/conversations/{cid}/appointment on the emulators (architecture §5, 28 Oct): either
// participant proposes, the other confirms or declines, the proposer withdraws, either one cancels
// or reschedules; every step is a system message counted as unread for the other one; blocked and
// frozen conversations refuse; the reminder job writes its system message and mails both members.

const HOUR = 3_600_000;
const QUARTER = 15 * 60_000;
const deliveries: Delivery[] = [];

beforeEach(() => {
  resetRateLimiters();
  setMessagingValkeyForTests(new FakeValkey().asClient());
  deliveries.length = 0;
  setEventPublisherForTests(async (items) => {
    deliveries.push(...items);
  });
  vi.mocked(sendMail).mockClear();
});

afterAll(() => {
  setMessagingValkeyForTests(undefined);
  setEventPublisherForTests(undefined);
});

/** A quarter-hour start `hours` from now. */
const startIn = (hours: number) => Math.ceil((Date.now() + hours * HOUR) / QUARTER) * QUARTER;

function act(who: Member, cid: string, body: unknown): Promise<CallResult<AppointmentResponse & ErrorBody>> {
  return call(appointmentRoute, "POST", MESSAGING_API.appointment(cid), { member: who, params: { cid }, body });
}

async function actOk(who: Member, cid: string, body: unknown): Promise<AppointmentResponse> {
  const result = await act(who, cid, body);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  return result.body;
}

async function conversation(): Promise<{ buyer: Member; seller: Member; cid: string }> {
  const [buyer, seller] = await Promise.all([member({ displayName: "Youssef Acheteur" }), member({ displayName: "Salma Vendeuse" })]);
  const { id } = await seedListing(seller);
  const { cid } = await startOk(buyer, id);
  return { buyer, seller, cid };
}

const conversationDoc = async (cid: string) => (await db().collection(COLLECTIONS.conversations).doc(cid).get()).data()!;

describe("POST /api/conversations/{cid}/appointment", () => {
  it("lets the seller propose slots and the buyer confirm one, each step a system message", async () => {
    const { buyer, seller, cid } = await conversation();
    const slots = [{ start: startIn(50), minutes: 30 }, { start: startIn(26), minutes: 60 }];
    const proposed = await actOk(seller, cid, { action: "propose", kind: "visit", slots, place: "Agence, voir www.exemple.com" });
    expect(proposed.appointment).toMatchObject({ kind: "visit", status: "proposed", proposedByMe: true, place: "Agence, voir ⟦url⟧" });
    expect(proposed.appointment.slots.map((slot) => slot.start)).toEqual([slots[1]!.start, slots[0]!.start]);

    // The buyer sees it on the conversation and in the thread, and it counts as unread for him.
    const page = await thread(buyer, cid);
    expect(page.body.conversation.appointment).toMatchObject({ status: "proposed", proposedByMe: false });
    expect(page.body.messages[0]).toMatchObject({ type: "system", text: "⟦rdv:proposed⟧", appointment: { event: "proposed", kind: "visit", byMe: false } });
    expect(page.body.conversation.unread).toBe(1);
    expect(page.body.conversation.lastMessage.preview).toBe("⟦rdv:proposed⟧");
    expect(deliveries.some((item) => item.uid === buyer.uid && item.event.type === "message")).toBe(true);

    // The proposer cannot confirm his own slots.
    expectError(await act(seller, cid, { action: "confirm", id: proposed.appointment.id, start: slots[0]!.start }), 409, "appointment_changed");
    const confirmed = await actOk(buyer, cid, { action: "confirm", id: proposed.appointment.id, start: slots[0]!.start });
    expect(confirmed.appointment).toMatchObject({ status: "confirmed", chosen: slots[0], proposedByMe: false });
    const stored = await conversationDoc(cid);
    expect(stored.appointmentRemindAt.toMillis()).toBe(slots[0]!.start - 24 * HOUR);
    const sellerPage = await thread(seller, cid);
    expect(sellerPage.body.messages[0]).toMatchObject({ appointment: { event: "confirmed", byMe: false, slot: slots[0] } });

    // A second confirmation of the same proposal is stale.
    expectError(await act(buyer, cid, { action: "confirm", id: proposed.appointment.id, start: slots[0]!.start }), 409, "appointment_changed");
  });

  it("lets the buyer propose, the seller decline, and the proposer withdraw", async () => {
    const { buyer, seller, cid } = await conversation();
    const first = await actOk(buyer, cid, { action: "propose", kind: "test_drive", slots: [{ start: startIn(5), minutes: 30 }] });
    expectError(await act(buyer, cid, { action: "decline", id: first.appointment.id }), 409, "appointment_changed");
    const declined = await actOk(seller, cid, { action: "decline", id: first.appointment.id });
    expect(declined.appointment.status).toBe("declined");
    const second = await actOk(seller, cid, { action: "propose", kind: "test_drive", slots: [{ start: startIn(8), minutes: 45 }] });
    expect((await thread(buyer, cid)).body.messages[0]).toMatchObject({ appointment: { event: "proposed" } });
    expectError(await act(buyer, cid, { action: "withdraw", id: second.appointment.id }), 409, "appointment_changed");
    expect((await actOk(seller, cid, { action: "withdraw", id: second.appointment.id })).appointment.status).toBe("withdrawn");
  });

  it("cancels a confirmed slot with a reason and reschedules an active one", async () => {
    const { buyer, seller, cid } = await conversation();
    const start = startIn(30);
    const proposed = await actOk(seller, cid, { action: "propose", kind: "pickup", slots: [{ start, minutes: 15 }] });
    await actOk(buyer, cid, { action: "confirm", id: proposed.appointment.id, start });
    const moved = await actOk(buyer, cid, { action: "propose", kind: "pickup", slots: [{ start: startIn(40), minutes: 15 }] });
    expect(moved.appointment).toMatchObject({ status: "proposed", proposedByMe: true });
    expect((await thread(seller, cid)).body.messages[0]).toMatchObject({ appointment: { event: "rescheduled", byMe: false } });
    expect((await conversationDoc(cid)).appointmentRemindAt).toBeUndefined();

    const again = await actOk(seller, cid, { action: "confirm", id: moved.appointment.id, start: moved.appointment.slots[0]!.start });
    const cancelled = await actOk(seller, cid, { action: "cancel", id: again.appointment.id, reason: "sold" });
    expect(cancelled.appointment).toMatchObject({ status: "cancelled", cancelledByMe: true, reason: "sold" });
    expect((await thread(buyer, cid)).body.messages[0]).toMatchObject({ appointment: { event: "cancelled", reason: "sold", byMe: false } });
    expect((await conversationDoc(cid)).appointmentRemindAt).toBeUndefined();
  });

  it("refuses invalid slots, strangers, blocked and frozen conversations", async () => {
    const { buyer, seller, cid } = await conversation();
    expectError(await act(seller, cid, { action: "propose", kind: "visit", slots: [{ start: startIn(0.25), minutes: 30 }] }), 400, "invalid_body");
    expectError(await act(seller, cid, { action: "propose", kind: "visit", slots: [{ start: startIn(5), minutes: 60 }, { start: startIn(5) + QUARTER * 2, minutes: 30 }] }), 400, "invalid_body");
    expectError(await act(seller, cid, { action: "propose", kind: "visit", slots: [{ start: startIn(5) + 60_000, minutes: 30 }] }), 400, "invalid_body");
    const stranger = await member({ displayName: "Inconnu Curieux" });
    expectError(await act(stranger, cid, { action: "propose", kind: "visit", slots: [{ start: startIn(5), minutes: 30 }] }), 404, "not_found");

    expect((await setState(buyer, cid, { blocked: true })).status).toBe(204);
    expectError(await act(seller, cid, { action: "propose", kind: "visit", slots: [{ start: startIn(5), minutes: 30 }] }), 403, "conversation_blocked");
    expect((await setState(buyer, cid, { blocked: false })).status).toBe(204);

    expect(await freezeConversation(cid, "authority:test", true)).toBe(true);
    expectError(await act(seller, cid, { action: "propose", kind: "visit", slots: [{ start: startIn(5), minutes: 30 }] }), 409, "conversation_unavailable");
  });
});

describe("the place of a proposal (audit A-02)", () => {
  // Far enough for the reminder test's job run (a day before its own slot) to leave it alone.
  const slots = () => [{ start: startIn(500), minutes: 30 }];
  const messageDoc = async (cid: string, mid: string) => (await db().collection(COLLECTIONS.conversations).doc(cid).collection(COLLECTIONS.messages).doc(mid).get()).data()!;
  const reportCode = (promise: Promise<unknown>) =>
    promise.then(
      () => "ok",
      (error: { status?: number; code?: string }) => `${error.status} ${error.code}`,
    );

  it("refuses bank details and payment terms before writing anything", async () => {
    const { buyer, seller, cid } = await conversation();
    expectError(await act(seller, cid, { action: "propose", kind: "visit", slots: slots(), place: "Agence, RIB 011 780 0000123456789012 34" }), 422, "place_payment_details");
    expectError(await act(buyer, cid, { action: "propose", kind: "visit", slots: slots(), place: "Virement de l'acompte avant la visite" }), 422, "place_payment_details");
    const page = await thread(buyer, cid);
    expect(page.body.messages).toHaveLength(1);
    expect(page.body.conversation.appointment).toBeNull();
  });

  it("lets the other member report the proposal, and moderation hide and restore its place", async () => {
    const { buyer, seller, cid } = await conversation();
    const proposed = await actOk(seller, cid, { action: "propose", kind: "visit", slots: slots(), place: "Café du parc, Maârif" });
    const mid = proposed.messageId;
    expect((await thread(buyer, cid)).body.messages[0]).toMatchObject({ appointment: { event: "proposed", place: "Café du parc, Maârif" } });

    // The other member reports it like a message; the author cannot, a confirmation carries no place.
    const target = await resolveReportTarget({ type: "message", id: `${cid}/${mid}` }, buyer.uid);
    expect(target.target).toMatchObject({ type: "message", id: `${cid}/${mid}`, ownerUid: seller.uid });
    expect(await reportCode(resolveReportTarget({ type: "message", id: `${cid}/${mid}` }, seller.uid))).toBe("403 report_not_allowed");
    const confirmed = await actOk(buyer, cid, { action: "confirm", id: proposed.appointment.id, start: proposed.appointment.slots[0]!.start });
    expect(await reportCode(resolveReportTarget({ type: "message", id: `${cid}/${confirmed.messageId}` }, seller.uid))).toBe("422 report_target_invalid");

    // Hidden: gone from the step and from the current appointment (card, reminder mails), kept as evidence.
    expect(await hideMessage(cid, mid, "decision:test")).toBe(true);
    const hidden = await messageDoc(cid, mid);
    expect(hidden).toMatchObject({ hidden: true, text: "⟦rdv:proposed⟧" });
    expect(hidden.appointment.place).toBeUndefined();
    expect((await conversationDoc(cid)).appointment.place).toBeUndefined();
    expect((await db().collection(COLLECTIONS.conversations).doc(cid).collection(COLLECTIONS.evidence).doc(mid).get()).data()).toMatchObject({ text: "Café du parc, Maârif", reason: "hidden" });
    expect((await thread(buyer, cid)).body.messages.find((message) => message.id === mid)).toMatchObject({ hidden: true, appointment: { place: null } });
    expect(await reportCode(resolveReportTarget({ type: "message", id: `${cid}/${mid}` }, buyer.uid))).toBe("422 report_target_invalid");

    // Restored on appeal: back on the step and on the appointment, the evidence deleted.
    expect(await unhideMessage(cid, mid)).toBe(true);
    expect((await messageDoc(cid, mid)).appointment.place).toBe("Café du parc, Maârif");
    expect((await conversationDoc(cid)).appointment.place).toBe("Café du parc, Maârif");
    expect((await db().collection(COLLECTIONS.conversations).doc(cid).collection(COLLECTIONS.evidence).doc(mid).get()).exists).toBe(false);
  });
});

describe("job appointment-reminders", () => {
  it("posts the due reminder in the thread, mails both members, then moves to the next one", async () => {
    const { buyer, seller, cid } = await conversation();
    const start = startIn(30);
    const proposed = await actOk(seller, cid, { action: "propose", kind: "visit", slots: [{ start, minutes: 30 }], place: "Agence Maârif" });
    await actOk(buyer, cid, { action: "confirm", id: proposed.appointment.id, start });
    const unreadBefore = (await getConversation(cid))!.unread;

    // Not due yet.
    expect(await listDueReminders(new Date())).not.toContain(cid);
    const dayBefore = new Date(start - 24 * HOUR + 60_000);
    expect(await listDueReminders(dayBefore)).toContain(cid);
    deliveries.length = 0;
    const result = await sendAppointmentReminders(dayBefore);
    expect(result.reminded).toBeGreaterThanOrEqual(1);
    const page = await thread(buyer, cid);
    expect(page.body.messages[0]).toMatchObject({ type: "system", text: "⟦rdv:reminder⟧", appointment: { event: "reminder", slot: { start, minutes: 30 } } });
    expect((await getConversation(cid))!.unread).toEqual(unreadBefore);
    expect((await conversationDoc(cid)).appointmentRemindAt.toMillis()).toBe(start - 2 * HOUR);
    const mails = vi.mocked(sendMail).mock.calls.map(([mail]) => mail).filter((mail) => mail.template === "appointmentReminder");
    expect(mails).toHaveLength(2);
    expect(mails[0]).toMatchObject({ data: { kind: "visit", startsAt: new Date(start).toISOString(), place: "Agence Maârif", cid } });
    expect(deliveries.filter((item) => item.event.type === "message").map((item) => item.uid).sort()).toEqual([buyer.uid, seller.uid].sort());

    // The same run again sends nothing; the last reminder then clears the field.
    expect((await sendAppointmentReminders(dayBefore)).reminded).toBe(0);
    await sendAppointmentReminders(new Date(start - 2 * HOUR + 60_000));
    expect((await conversationDoc(cid)).appointmentRemindAt).toBeUndefined();
  });

  it("drops the reminder of a conversation blocked meanwhile", async () => {
    const { buyer, seller, cid } = await conversation();
    const start = startIn(30);
    const proposed = await actOk(seller, cid, { action: "propose", kind: "visit", slots: [{ start, minutes: 30 }] });
    await actOk(buyer, cid, { action: "confirm", id: proposed.appointment.id, start });
    expect((await setState(buyer, cid, { blocked: true })).status).toBe(204);
    vi.mocked(sendMail).mockClear();
    await sendAppointmentReminders(new Date(start - 24 * HOUR + 60_000));
    expect((await conversationDoc(cid)).appointmentRemindAt).toBeUndefined();
    expect(vi.mocked(sendMail).mock.calls.filter(([mail]) => mail.template === "appointmentReminder")).toHaveLength(0);
  });
});
