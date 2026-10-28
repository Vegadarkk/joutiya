import "server-only";
import type { DocumentSnapshot } from "firebase-admin/firestore";
import { LOCALES, type Locale } from "@/config/site";
import { requireCsrf, requireUser } from "@/lib/auth/guards";
import {
  ACCOUNT_EXPORT_FORMAT,
  ACCOUNT_EXPORT_VERSION,
  type AccountExport,
  type ExportConversation,
  type ExportDecision,
  type ExportListing,
  type ExportReport,
  type ExportSection,
} from "@/lib/contracts/account";
import { LISTING_STATUSES } from "@/lib/contracts/listings";
import { listDecisionsForUser, type ModerationDecisionRecord } from "@/lib/db/repositories/moderation-decisions";
import { fromSnapshot as listingFromSnapshot } from "@/lib/db/repositories/listings";
import { proProfileFromSnapshot } from "@/lib/db/repositories/pro-profiles";
import { timestampsToDates } from "@/lib/db/repositories/timestamps";
import { COLLECTIONS, moderationDecisionSchema, reportSchema, userPrivateSchema, userSchema, type ModerationDecisionDoc, type ReportDoc } from "@/lib/db/schemas";
import { listFavoritesPage } from "@/lib/favorites/repository";
import { db } from "@/lib/firebase/admin";
import { getLegalConfig } from "@/lib/legal/config";
import { listInboxPage, listThreadPage, type ConversationRecord, type MessageRecord } from "@/lib/messaging/repository";
import { PRO_ID_PATTERN } from "@/lib/pro/profile-schema";
import { consume } from "@/lib/quota";
import { assertQuotas } from "@/lib/quota/gate";
import { enforceLimit } from "@/lib/rate-limit/limiter";
import { listSavedSearches } from "@/lib/saved-searches/repository";
import { EXPORT_LIMITS, messageAllowances } from "./rules";

// GET /api/account/export (phase 5 design D26, lot L7): the member's personal data as one JSON
// file (RGPD art. 15 access, art. 20 portability; loi 09-08). Only what the account itself wrote
// or sees of itself: the profile and private settings, its listings (ended ones included), its
// conversations and their messages as stored (masked; never the evidence of a masked or hidden
// message, never more of the other participant than the conversation shows), the reports it filed
// and its own appeals, the decisions about it and its appeals, favorites, saved searches, the
// accounts it blocked. Never a staff field: AI proposals and verdicts, moderator ids and notes on a
// report, risk scores, legal holds, who reported the account. Every list is bounded (rules.ts
// EXPORT_LIMITS, ~2 000 Firestore reads at most) and says so in `truncated` when it was cut.

const iso = (value: Date | null | undefined): string | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null);
const localeOf = (value: unknown): Locale => ((LOCALES as readonly unknown[]).includes(value) ? (value as Locale) : "fr");

function parse<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, snapshot: DocumentSnapshot | undefined): T | null {
  const data = snapshot?.data();
  if (!data) return null;
  const parsed = schema.safeParse(timestampsToDates(data));
  return parsed.success ? parsed.data : null;
}

// ---- Reads ---------------------------------------------------------------------------------------

/** Every status but the purge tombstone (which no longer has an owner), newest change first. */
const EXPORT_LISTING_STATUSES = LISTING_STATUSES.filter((status) => status !== "purged");

async function readListings(uid: string): Promise<{ listings: ExportListing[]; more: boolean }> {
  const snapshot = await db()
    .collection(COLLECTIONS.listings)
    .where("ownerUid", "==", uid)
    .where("status", "in", [...EXPORT_LISTING_STATUSES])
    .orderBy("updatedAt", "desc")
    .limit(EXPORT_LIMITS.listings + 1)
    .get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const listings = snapshot.docs
    .slice(0, EXPORT_LIMITS.listings)
    .map(listingFromSnapshot)
    .flatMap((listing): ExportListing[] =>
      listing
        ? [
            {
              id: listing.id,
              slugId: listing.slugId ?? null,
              status: listing.status,
              pausedReason: listing.pausedReason ?? null,
              sellerName: listing.sellerName,
              sellerType: listing.sellerType,
              title: listing.title,
              description: listing.description,
              categoryId: listing.categoryId ?? null,
              subcategoryId: listing.subcategoryId ?? null,
              attributes: listing.attributes as Record<string, unknown>,
              condition: listing.condition ?? null,
              price: listing.price,
              priceNegotiable: listing.priceNegotiable,
              isDonation: listing.isDonation,
              location: listing.location ? { regionCode: listing.location.regionCode, citySlug: listing.location.citySlug, district: listing.location.district ?? null } : null,
              photoIds: listing.photos.map((photo) => photo.id),
              contact: { messaging: listing.contact.messaging, showPhone: listing.contact.showPhone, whatsapp: listing.contact.whatsapp },
              sensitiveDeclaration: listing.moderation.sensitiveDeclaration ? { kind: listing.moderation.sensitiveDeclaration.kind, at: listing.moderation.sensitiveDeclaration.at.toISOString() } : null,
              createdAt: listing.createdAt.toISOString(),
              updatedAt: listing.updatedAt.toISOString(),
              publishedAt: iso(listing.publishedAt),
              expiresAt: iso(listing.expiresAt),
            },
          ]
        : [],
    );
  return { listings, more: snapshot.size > EXPORT_LIMITS.listings };
}

function messageOf(message: MessageRecord, uid: string): ExportConversation["messages"][number] {
  return {
    mine: message.senderUid === uid,
    type: message.type,
    text: message.text,
    flags: message.risk?.flags ?? [],
    hidden: message.hidden === true,
    createdAt: message.createdAt.toISOString(),
    readAt: iso(message.readAt),
  };
}

/** What the participant sees of a conversation (views.ts conversationView), with its messages oldest first. */
function conversationOf(conversation: ConversationRecord, uid: string, messages: readonly MessageRecord[], truncated: boolean): ExportConversation {
  const buyer = conversation.buyerUid === uid;
  return {
    cid: conversation.cid,
    role: buyer ? "buyer" : "seller",
    listing: { slugId: conversation.listingSlugId, title: conversation.listingSnapshot.title, price: conversation.listingSnapshot.price, isDonation: conversation.listingSnapshot.isDonation },
    counterpart: buyer ? { publicId: conversation.sellerPublicId, displayName: conversation.sellerName } : { publicId: conversation.buyerPublicId, displayName: conversation.buyerName },
    archived: conversation.archivedBy.includes(uid),
    deletedForMe: conversation.hiddenFor.includes(uid),
    blockedByMe: conversation.blockedBy.includes(uid),
    frozen: conversation.status === "frozen",
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
    messages: [...messages].reverse().map((message) => messageOf(message, uid)),
    messagesTruncated: truncated,
  };
}

async function readConversations(uid: string): Promise<{ conversations: ExportConversation[]; more: boolean; messagesCut: boolean }> {
  const page = await listInboxPage(uid, EXPORT_LIMITS.conversations);
  // A participant only (the query says so; checked again, a document never leaks by a bad index).
  const mine = page.items.filter((conversation) => conversation.participants.includes(uid));
  const allowances = messageAllowances(mine.map((conversation) => Math.max(1, conversation.messageCount)));
  const conversations: ExportConversation[] = [];
  let messagesCut = false;
  for (const [index, conversation] of mine.entries()) {
    const allowance = allowances[index] ?? 0;
    const thread = allowance > 0 ? await listThreadPage(conversation.cid, allowance) : { items: [] as MessageRecord[], more: conversation.messageCount > 0 };
    if (thread.more) messagesCut = true;
    conversations.push(conversationOf(conversation, uid, thread.items, thread.more));
  }
  return { conversations, more: page.more, messagesCut };
}

type Appeal = NonNullable<ModerationDecisionDoc["appeal"]>;

/** An appeal as its author sees it (the outcome mail says as much): never the reviewer's id. */
function appealOf(appeal: Appeal): ExportReport["appeal"] {
  return { status: appeal.status, text: appeal.text ?? null, openedAt: appeal.openedAt.toISOString(), closedAt: iso(appeal.closedAt), note: appeal.status === "open" ? null : (appeal.note ?? null) };
}

async function readReportsFiled(uid: string): Promise<{ reports: ExportReport[]; more: boolean }> {
  const snapshot = await db().collection(COLLECTIONS.reports).where("reporter.uid", "==", uid).orderBy("createdAt", "desc").limit(EXPORT_LIMITS.reportsFiled + 1).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const records = snapshot.docs
    .slice(0, EXPORT_LIMITS.reportsFiled)
    .map((doc) => ({ id: doc.id, report: parse<ReportDoc>(reportSchema, doc) }))
    .filter((item): item is { id: string; report: ReportDoc } => item.report !== null && item.report.reporter.uid === uid);
  // The notifier's own appeal lives on the decision that closed the report.
  const decisionIds = [...new Set(records.map((item) => item.report.decisionId).filter((id): id is string => typeof id === "string" && id.length > 0 && !id.includes("/")))];
  const decisions = new Map<string, ModerationDecisionDoc>();
  if (decisionIds.length > 0) {
    const snapshots = await db().getAll(...decisionIds.map((id) => db().collection(COLLECTIONS.moderationDecisions).doc(id)));
    void consume("firestore.reads", decisionIds.length);
    for (const doc of snapshots) {
      const decision = parse<ModerationDecisionDoc>(moderationDecisionSchema, doc);
      if (decision) decisions.set(doc.id, decision);
    }
  }
  const reports = records.map(({ id, report }): ExportReport => {
    const appeal = report.decisionId ? decisions.get(report.decisionId)?.appeal : undefined;
    const own = appeal && appeal.by === "reporter" && appeal.reportId === id ? appeal : undefined;
    const target = report.target;
    return {
      id,
      target: { type: target.type, listingId: target.type === "listing" ? target.id : (target.listingId ?? null), publicId: target.type === "user" ? (target.publicId ?? null) : null },
      reasonId: report.reasonId,
      explanation: report.explanation,
      reporter: { name: report.reporter.name ?? null, email: report.reporter.email ?? null, locale: report.reporter.locale },
      status: report.status,
      outcome: report.outcome ?? null,
      createdAt: report.createdAt.toISOString(),
      closedAt: iso(report.closedAt),
      appeal: own ? appealOf(own) : null,
    };
  });
  return { reports, more: snapshot.size > EXPORT_LIMITS.reportsFiled };
}

function decisionOf(decision: ModerationDecisionRecord): ExportDecision {
  // A notifier's appeal on a decision about this account is the notifier's, not this account's.
  const appeal = decision.appeal && decision.appeal.by !== "reporter" ? appealOf(decision.appeal) : null;
  return {
    decisionId: decision.id,
    action: decision.action,
    targetType: decision.target.type,
    templateId: decision.templateId,
    durationDays: decision.durationDays ?? null,
    origin: decision.origin,
    automated: { detection: decision.automation.detection, decision: decision.automation.decision },
    facts: decision.facts,
    ground: { type: decision.ground.type, ref: decision.ground.ref, explanation: decision.ground.explanation },
    createdAt: decision.createdAt.toISOString(),
    notifiedAt: iso(decision.notifiedAt),
    appealDeadline: decision.appealDeadline.toISOString(),
    appeal,
  };
}

async function readBlocked(uids: readonly string[]): Promise<AccountExport["blockedAccounts"]> {
  const ids = uids.slice(0, EXPORT_LIMITS.blockedAccounts);
  if (ids.length === 0) return [];
  const snapshots = await db().getAll(...ids.map((id) => db().collection(COLLECTIONS.users).doc(id)));
  void consume("firestore.reads", ids.length);
  return snapshots.flatMap((snapshot) => {
    const publicId: unknown = snapshot.get("publicId");
    const displayName: unknown = snapshot.get("displayName");
    return snapshot.exists && typeof publicId === "string" && typeof displayName === "string" ? [{ publicId, displayName }] : [];
  });
}

// ---- The file ------------------------------------------------------------------------------------

const ABOUT: Record<"fr" | "ar", (date: string, contact: string) => string[]> = {
  fr: (date, contact) => [
    `Données personnelles de votre compte Joutiya, au ${date} : profil, paramètres, consentements, annonces (terminées comprises), favoris, recherches enregistrées, conversations et messages, signalements envoyés, décisions de modération vous concernant et vos recours, comptes bloqués.`,
    "Les messages sont tels qu'ils sont enregistrés : liens et coordonnées masqués, messages retirés par la modération remplacés par une mention.",
    "Les photos de vos annonces sont désignées par leur identifiant et ne sont pas jointes au fichier.",
    `Ne figurent pas dans ce fichier : les journaux de connexion (adresse IP, conservés un an pour répondre aux autorités) et les pièces justificatives d'un compte professionnel. Vous pouvez les demander à ${contact}.`,
    "Les listes trop longues sont limitées aux éléments les plus récents ; la rubrique « truncated » indique lesquelles.",
  ],
  ar: (date, contact) => [
    `البيانات الشخصية لحسابك على Joutiya بتاريخ ${date}: الملف الشخصي، الإعدادات، الموافقات، الإعلانات (بما فيها المنتهية)، المفضلات، عمليات البحث المحفوظة، المحادثات والرسائل، البلاغات المرسلة، قرارات الإشراف المتعلقة بك وطعونك، الحسابات المحظورة.`,
    "الرسائل كما هي محفوظة: الروابط ووسائل الاتصال مخفية، والرسائل التي أزالها فريق الإشراف مستبدلة بإشارة.",
    "صور إعلاناتك مذكورة بمعرّفاتها ولا يتضمنها الملف.",
    `لا يتضمن هذا الملف سجلات الاتصال (عنوان IP، يُحتفظ بها سنة واحدة للرد على طلبات السلطات) ولا وثائق إثبات الحساب المهني. يمكنك طلبها عبر ${contact}.`,
    "القوائم الطويلة جدًا مقتصرة على أحدث العناصر، ويبيّن قسم «truncated» القوائم المعنية.",
  ],
};

/** Builds the export of `uid` (the caller checked the session and the limits). */
export async function buildAccountExport(uid: string, now = new Date()): Promise<AccountExport> {
  const users = db().collection(COLLECTIONS.users);
  const [userSnap, accountSnap, blocksSnap] = await db().getAll(users.doc(uid), users.doc(uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc), db().collection(COLLECTIONS.userBlocks).doc(uid));
  void consume("firestore.reads", 3);
  const user = parse(userSchema, userSnap);
  const account = parse(userPrivateSchema, accountSnap);
  const proId = user?.proId && PRO_ID_PATTERN.test(user.proId) ? user.proId : null;
  let pro: AccountExport["pro"] = null;
  if (proId) {
    const snapshot = await db().collection(COLLECTIONS.proProfiles).doc(proId).get();
    void consume("firestore.reads", 1);
    const profile = proProfileFromSnapshot(snapshot);
    if (profile && profile.ownerUid === uid) {
      const check = profile.kybc.phoneCheck;
      pro = {
        name: profile.name,
        slug: profile.slug,
        description: profile.description,
        website: profile.website ?? null,
        regionCode: profile.regionCode,
        citySlug: profile.citySlug,
        whatsapp: profile.whatsapp,
        phonePublic: profile.phonePublic ?? null,
        legal: Object.fromEntries(Object.entries(profile.legal).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        verification: {
          status: profile.kybc.status,
          submittedAt: iso(profile.kybc.submittedAt),
          pieces: profile.kybc.uploadIds.length,
          rejectReason: profile.kybc.rejectReason ?? null,
          phoneCheck: check ? { at: check.at.toISOString(), outcome: check.outcome, phone: check.phone } : null,
        },
        certifiedAt: iso(profile.certified?.at),
        lifecycle: profile.lifecycle,
        plan: profile.plan,
        planSource: profile.planSource,
        createdAt: profile.createdAt.toISOString(),
      };
    }
  }

  const [listings, favorites, savedSearches, conversations, reportsFiled, decisions] = await Promise.all([
    readListings(uid),
    listFavoritesPage(uid, EXPORT_LIMITS.favorites),
    listSavedSearches(uid),
    readConversations(uid),
    readReportsFiled(uid),
    listDecisionsForUser(uid, EXPORT_LIMITS.decisions + 1),
  ]);
  const blockedUids: unknown = blocksSnap?.get("uids");
  const blocked = Array.isArray(blockedUids) ? blockedUids.filter((id): id is string => typeof id === "string" && id.length > 0 && !id.includes("/")) : [];
  const blockedAccounts = await readBlocked(blocked);

  const truncated: AccountExport["truncated"] = {};
  const cut = (section: ExportSection, when: boolean) => {
    if (when) truncated[section] = { limit: EXPORT_LIMITS[section] };
  };
  cut("listings", listings.more);
  cut("favorites", favorites.next !== undefined);
  cut("conversations", conversations.more);
  cut("messages", conversations.messagesCut);
  cut("reportsFiled", reportsFiled.more);
  cut("decisions", decisions.length > EXPORT_LIMITS.decisions);
  cut("blockedAccounts", blocked.length > EXPORT_LIMITS.blockedAccounts);

  const locale = localeOf(user?.locale);
  const legal = await getLegalConfig();
  const contact = legal.dpoContact?.trim() || legal.email;
  const lang = locale === "ar" ? "ar" : "fr";
  const date = new Intl.DateTimeFormat(lang === "ar" ? "ar-MA" : "fr-MA", { dateStyle: "long", timeZone: "Africa/Casablanca" }).format(now);

  return {
    format: ACCOUNT_EXPORT_FORMAT,
    version: ACCOUNT_EXPORT_VERSION,
    generatedAt: now.toISOString(),
    about: ABOUT[lang](date, contact),
    truncated,
    profile: user
      ? {
          publicId: user.publicId,
          displayName: user.displayName,
          type: user.type,
          regionCode: user.regionCode ?? null,
          citySlug: user.citySlug ?? null,
          locale: user.locale,
          status: user.status,
          badges: { ...user.badges },
          stats: { activeListings: user.stats.activeListings, responseRate: user.stats.responseRate, medianReplyMin: user.stats.medianReplyMin, ratingAvg: user.stats.ratingAvg ?? null, ratingCount: user.stats.ratingCount },
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        }
      : null,
    account: account
      ? {
          email: account.email,
          phone: account.phoneE164 ?? null,
          phoneVerifiedAt: iso(account.phoneVerifiedAt),
          legalName: account.legalName ?? null,
          providers: [...account.providers],
          consents: {
            cgu: { version: account.consents.cgu.version, at: account.consents.cgu.at.toISOString() },
            transfers: { version: account.consents.transfers.version, at: account.consents.transfers.at.toISOString() },
            marketing: account.consents.marketing,
          },
          notifications: { messagesEmail: account.notifications?.messagesEmail ?? true },
          sanctions: { strikeLevel: account.strikes.level, lastAt: iso(account.strikes.lastAt), suspendedUntil: iso(account.strikes.suspendedUntil) },
          reporting: { abusiveUntil: iso(account.reporter.abusiveUntil), warnedAt: iso(account.reporter.warnedAt) },
        }
      : null,
    pro,
    listings: listings.listings,
    favorites: favorites.favorites.map((favorite) => ({
      listingId: favorite.listingId,
      slugId: favorite.listingSnapshot.slugId,
      title: favorite.listingSnapshot.title,
      price: favorite.listingSnapshot.price,
      isDonation: favorite.listingSnapshot.isDonation,
      savedAt: favorite.createdAt.toISOString(),
    })),
    savedSearches: savedSearches.map((search) => ({
      name: search.name,
      params: search.params as Record<string, unknown>,
      alert: search.alert,
      createdAt: search.createdAt.toISOString(),
      updatedAt: search.updatedAt.toISOString(),
      lastAlertAt: iso(search.lastAlertAt),
    })),
    conversations: conversations.conversations,
    reportsFiled: reportsFiled.reports,
    decisions: decisions.slice(0, EXPORT_LIMITS.decisions).filter((decision) => decision.affectedUid === uid).map(decisionOf),
    blockedAccounts,
  };
}

/** joutiya-mes-donnees-2026-10-20.json */
export function exportFileName(now: Date): string {
  return `joutiya-mes-donnees-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * GET /api/account/export. A GET that spends a daily allowance and hands out personal data: the
 * X-CSRF-Token header is required too (a link from another site would carry the Lax session
 * cookie, never the header), and the session is checked against revocation. Suspended accounts
 * may download theirs.
 */
export async function handleAccountExport(request: Request): Promise<Response> {
  const context = await requireUser(request, { checkRevoked: true, allowSuspended: true });
  requireCsrf(request, context.session);
  const { uid } = context.user;
  await enforceLimit("account.export.uid", uid);
  await assertQuotas(["firestore.reads"]);
  const now = new Date();
  const data = await buildAccountExport(uid, now);
  return new Response(JSON.stringify(data, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(now)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
