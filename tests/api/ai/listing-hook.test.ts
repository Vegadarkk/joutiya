import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AgentQueue from "@/lib/ai/queue";

// The listings producers of the agent queue (design D19, D20; audit D1b-01) against the
// emulators, the queue mocked: a publication (published or held) and a screened renewal enqueue
// `listing_screen` with the committed version, a renewal of content a moderator approved does
// not, and a queue failure never fails the publication.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("@/lib/ai/queue", async (importOriginal) => ({ ...(await importOriginal<typeof AgentQueue>()), enqueueAiTask: vi.fn(async () => ({ queued: true })) }));

import { POST as create } from "@/app/api/listings/route";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { POST as renew } from "@/app/api/listings/[id]/renew/route";
import { enqueueAiTask } from "@/lib/ai/queue";
import type { CreateListingResponse } from "@/lib/contracts/listings";
import { getListing, updateListing } from "@/lib/db/repositories/listings";
import { resetServerEnv } from "@/lib/env";
import { DAY_MS, api, member, readyPatch, seedReadyUpload, type ErrorBody, type ListingBody, type Member, type PublishBody } from "../listings/helpers";
import { publishedListing } from "../reports/helpers";

const enqueueMock = vi.mocked(enqueueAiTask);
const SOFT_TITLE = "Réplique de vélo de course vintage";

beforeAll(() => resetServerEnv());
beforeEach(() => enqueueMock.mockClear());

/** A complete draft with one ready photo, title overridable (a "réplique" is a soft flag: held). */
async function readyDraft(owner: Member, title?: string): Promise<string> {
  const created = await api<CreateListingResponse>(create, "POST", "/api/listings", { member: owner, body: {} });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const uploadId = await seedReadyUpload(owner, id);
  const saved = await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { ...readyPatch(title ? { title } : {}), photos: [uploadId] } });
  expect(saved.status).toBe(200);
  return id;
}

/** The expiry job has run: expired a day ago, purge in a year (the job's own patch). */
async function expire(id: string): Promise<void> {
  const now = Date.now();
  await updateListing(id, { status: "expired", expiresAt: new Date(now - DAY_MS), purgeAt: new Date(now + 365 * DAY_MS) });
}

const screening = (id: string, version: number) => ["listing_screen", { type: "listing", id }, { version }] as const;

describe("listing_screen producers", () => {
  it("queues a screening of a published listing under its committed version", async () => {
    const { id } = await publishedListing();
    const stored = (await getListing(id))!;
    expect(stored.status).toBe("published");
    expect(enqueueMock).toHaveBeenCalledExactlyOnceWith(...screening(id, stored.version));
  });

  it("queues a screening of a held listing too (the agent may approve it alone)", async () => {
    const owner = await member();
    const id = await readyDraft(owner, SOFT_TITLE);
    const held = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
    expect(held.body.status).toBe("pending_review");
    expect(enqueueMock).toHaveBeenCalledExactlyOnceWith(...screening(id, (await getListing(id))!.version));
  });

  it("never fails a publication because the queue is down", async () => {
    enqueueMock.mockRejectedValueOnce(new Error("agent job not enqueued in time"));
    const owner = await member();
    const id = await readyDraft(owner);
    const result = await api<PublishBody & ErrorBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("published");
    expect(enqueueMock).toHaveBeenCalledOnce();
  });

  it("queues a screening of a renewed expired listing under its new version", async () => {
    const { id, seller } = await publishedListing();
    await expire(id);
    const before = (await getListing(id))!;
    enqueueMock.mockClear();
    const renewed = await api<ListingBody & ErrorBody>(renew, "POST", `/api/listings/${id}/renew`, { member: seller });
    expect(renewed.status).toBe(200);
    expect(renewed.body.listing.status).toBe("published");
    const after = (await getListing(id))!;
    expect(after.version).toBeGreaterThan(before.version);
    expect(enqueueMock).toHaveBeenCalledExactlyOnceWith(...screening(id, after.version));
  });

  it("does not screen again content a moderator approved and unchanged since", async () => {
    const { id, seller } = await publishedListing();
    await expire(id);
    const current = (await getListing(id))!;
    await updateListing(id, { moderation: { ...current.moderation, state: "human_ok", reviewedBy: "moderator-1", reviewedAt: new Date() } });
    enqueueMock.mockClear();
    const renewed = await api<ListingBody & ErrorBody>(renew, "POST", `/api/listings/${id}/renew`, { member: seller });
    expect(renewed.status).toBe(200);
    expect(renewed.body.listing.status).toBe("published");
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
