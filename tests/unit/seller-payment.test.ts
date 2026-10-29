import { describe, expect, it } from "vitest";
import { parsePaymentLink, resolveSellerPaymentsConfig } from "@/config/seller-payments";
import { effectivePayment, foldPending, ownerPaymentLink, paymentShown } from "@/lib/pro/seller-payment-rules";
import type { SellerPaymentDoc } from "@/lib/pro/profile-schema";

// « Payer chez le vendeur » rules (design phase-7/boutique-temporaire.md §2): link shape, allowlist,
// 24-hour delay of a new link, visibility by shop state and suspension.

const at = (iso: string) => new Date(iso);
const config = { hosts: ["paiement.banque.ma", "pay.psp.ma"] };
const info = { address: "12 rue Allal Ben Abdellah, Fès", email: "contact@miel.ma", delivery: "Partout au Maroc en 3 jours, 30 MAD.", returns: "7 jours pour changer d'avis, retour à nos frais." };

describe("payment link shape", () => {
  it("keeps an https link and its host", () => {
    expect(parsePaymentLink(" https://Paiement.Banque.ma/pay/123?ref=a ")).toEqual({ host: "paiement.banque.ma", url: "https://paiement.banque.ma/pay/123?ref=a" });
  });

  it("refuses http, credentials, ports, IP literals, shorteners and garbage", () => {
    expect(parsePaymentLink("http://paiement.banque.ma/x")).toEqual({ problem: "https" });
    expect(parsePaymentLink("https://user:pw@paiement.banque.ma/x")).toEqual({ problem: "credentials" });
    expect(parsePaymentLink("https://paiement.banque.ma:8443/x")).toEqual({ problem: "port" });
    expect(parsePaymentLink("https://192.168.1.10/pay")).toEqual({ problem: "ip" });
    expect(parsePaymentLink("https://[::1]/pay")).toEqual({ problem: "ip" });
    expect(parsePaymentLink("https://bit.ly/abc")).toEqual({ problem: "shortener" });
    expect(parsePaymentLink("javascript:alert(1)")).toEqual({ problem: "https" });
    expect(parsePaymentLink("paiement banque")).toEqual({ problem: "invalid" });
    expect(parsePaymentLink("https://localhost/pay")).toEqual({ problem: "invalid" });
    // Under 500 characters as typed, over once percent-encoded: refused, not stored.
    expect(parsePaymentLink(`https://pay.psp.ma/${"م".repeat(100)}`)).toEqual({ problem: "invalid" });
  });
});

describe("config/sellerPayments", () => {
  it("defaults to no host and falls back whole on an invalid document", () => {
    expect(resolveSellerPaymentsConfig(undefined).config.hosts).toEqual([]);
    expect(resolveSellerPaymentsConfig({ hosts: ["pay.psp.ma"], updatedBy: "uid" })).toEqual({ config: { hosts: ["pay.psp.ma"] }, errors: [] });
    const invalid = resolveSellerPaymentsConfig({ hosts: ["*.psp.ma"] });
    expect(invalid.config.hosts).toEqual([]);
    expect(invalid.errors).toHaveLength(1);
  });
});

describe("link in force", () => {
  const base: SellerPaymentDoc = { cashOnDelivery: false, info, updatedAt: at("2026-11-01T10:00:00Z") };

  it("turns a new link active 24 hours after its save, the previous one serving meanwhile", () => {
    const payment = { ...base, url: "https://pay.psp.ma/old", pendingUrl: "https://paiement.banque.ma/new", pendingFrom: at("2026-11-01T10:00:00Z") };
    const before = effectivePayment(payment, config, at("2026-11-02T09:59:00Z"));
    expect(before).toMatchObject({ url: "https://pay.psp.ma/old", host: "pay.psp.ma", pending: { host: "paiement.banque.ma", activeFrom: at("2026-11-02T10:00:00Z") } });
    expect(effectivePayment(payment, config, at("2026-11-02T10:00:00Z"))).toEqual({ url: "https://paiement.banque.ma/new", host: "paiement.banque.ma", pending: null });
    // Folded at the next save.
    expect(foldPending(payment, config, at("2026-11-02T10:00:00Z"))).toEqual({ ...base, url: "https://paiement.banque.ma/new" });
    expect(foldPending(payment, config, at("2026-11-02T09:00:00Z"))).toBe(payment);
  });

  it("keeps a link on an unlisted host pending without a date, and hides a link whose host was withdrawn", () => {
    const waiting = effectivePayment({ ...base, pendingUrl: "https://new-psp.ma/pay", pendingFrom: at("2026-10-01T00:00:00Z") }, config, at("2026-11-01T00:00:00Z"));
    expect(waiting).toEqual({ url: null, host: null, pending: { url: "https://new-psp.ma/pay", host: "new-psp.ma", activeFrom: null } });
    expect(effectivePayment({ ...base, url: "https://pay.psp.ma/x" }, { hosts: [] }, at("2026-11-01T00:00:00Z")).url).toBeNull();
    expect(effectivePayment(undefined, config, at("2026-11-01T00:00:00Z"))).toEqual({ url: null, host: null, pending: null });
  });

  it("shows the button for verified shops with an offer only, never while suspended or without the seller information", () => {
    for (const lifecycle of ["verified", "active", "grace"]) expect(paymentShown(lifecycle, "essentiel", base)).toBe(true);
    for (const lifecycle of ["downgraded", "suspended", "pending_verification", "rejected"]) expect(paymentShown(lifecycle, "essentiel", base)).toBe(false);
    // Verified without an offer (launch offer over): no storefront, no button.
    expect(paymentShown("verified", "none", base)).toBe(false);
    expect(paymentShown("active", "essentiel", { ...base, suspendedAt: at("2026-11-01T00:00:00Z") })).toBe(false);
    expect(paymentShown("active", "essentiel", { suspendedAt: undefined, info: undefined })).toBe(false);
    expect(paymentShown("active", "essentiel", undefined)).toBe(false);
  });
});

describe("a listing's own link as its owner sees it (catalogue §6)", () => {
  const at = new Date("2026-11-02T10:00:00Z");
  it("counts a pending link once 24 hours old", () => {
    const link = { url: "https://paiement.banque-test.ma/a", pendingUrl: "https://paiement.banque-test.ma/b", pendingFrom: new Date(at.getTime() - 23 * 3_600_000) };
    expect(ownerPaymentLink(link, at)).toEqual({ url: "https://paiement.banque-test.ma/a", pending: { url: "https://paiement.banque-test.ma/b", host: "paiement.banque-test.ma", activeFrom: new Date(at.getTime() + 3_600_000) } });
    expect(ownerPaymentLink({ ...link, pendingFrom: new Date(at.getTime() - 24 * 3_600_000) }, at)).toEqual({ url: "https://paiement.banque-test.ma/b", pending: null });
    expect(ownerPaymentLink(undefined, at)).toEqual({ url: null, pending: null });
  });
});
