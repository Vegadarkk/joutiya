import { describe, expect, it } from "vitest";
import {
  RENTAL_CHECK_MIN_CONFIDENCE,
  agrementIssues,
  badDecisionDate,
  companyMatch,
  nameKey,
  referenceDigits,
  referenceKey,
  rentalCheckView,
  sameReference,
  type AgrementReading,
} from "@/lib/pro/rental-check-rules";

// The comparison of a car rental agency's licence decision with its declarations (decision 5):
// Claude reads, the server decides. Reference digits (one shop per verified reference), beneficiary
// by ICE (a name alone goes to a moderator), the date, signs of editing and Claude's confidence;
// every doubt is named for the moderator.

const NOW = new Date("2026-10-28T12:00:00.000Z");
const DECLARATION = { agrementRef: "AGR 123/2025", ice: "001234567000089", name: "Océan Rent" };
const READING: AgrementReading = {
  isAgrementDecision: true,
  legible: true,
  companyName: "STE OCEAN RENT SARL AU",
  ice: "001 234 567 000 089",
  reference: "N° 0123/2025",
  decisionDate: "2025-03-14",
  tamperingSigns: [],
  confidence: 0.93,
};

describe("licence references", () => {
  it("compare their digit groups, letters and leading zeros aside", () => {
    expect(referenceDigits("AGR 0123/2025")).toEqual(["123", "2025"]);
    expect(sameReference("AGR 123/2025", "N° 123-2025")).toBe(true);
    expect(sameReference("123/2025", "123/2024")).toBe(false);
    expect(sameReference("123/2025", "1232025")).toBe(false);
    expect(sameReference("123/2025", "")).toBe(false);
    expect(sameReference("0/2025", "0/2025")).toBe(true);
    expect(referenceKey("AGR 0123/2025")).toBe("123-2025");
    expect(referenceKey("N° 123-2025")).toBe("123-2025");
    expect(referenceKey("AGR")).toBe("");
  });
});

describe("the beneficiary", () => {
  it("is the shop by its 15-digit ICE, a different ICE never matching", () => {
    expect(companyMatch(DECLARATION, { ice: "001234567000089", companyName: "Autre nom" })).toBe("ice");
    expect(companyMatch(DECLARATION, { ice: "001234567000090", companyName: "Océan Rent" })).toBeNull();
  });

  it("else by its exact name, legal forms, accents and punctuation aside; a name containing the other never matches", () => {
    expect(nameKey("S.A.R.L. Océan-Rent")).toBe("oceanrent");
    expect(companyMatch(DECLARATION, { ice: "", companyName: "Société OCEAN RENT S.A.R.L" })).toBe("name");
    expect(companyMatch(DECLARATION, { ice: "", companyName: "Ocean Rent Cars" })).toBeNull();
    expect(companyMatch(DECLARATION, { ice: "", companyName: "Atlas Cars" })).toBeNull();
    expect(companyMatch({ ...DECLARATION, name: "AB" }, { ice: "", companyName: "AB" })).toBeNull();
    // Audit B-04: the real decision of a company with a shorter name does not pass for the shop.
    expect(companyMatch({ ...DECLARATION, name: "Marrakech Car Rental Premium" }, { ice: "", companyName: "Marrakech Car" })).toBeNull();
  });
});

describe("the decision date", () => {
  it("must be a real day, not after today in Morocco; absent is no issue", () => {
    expect(badDecisionDate("", NOW)).toBe(false);
    expect(badDecisionDate("2026-10-28", NOW)).toBe(false);
    expect(badDecisionDate("2026-10-29", NOW)).toBe(true);
    expect(badDecisionDate("2025-02-30", NOW)).toBe(true);
    expect(badDecisionDate("14/03/2025", NOW)).toBe(true);
  });
});

describe("agrementIssues", () => {
  it("finds none when everything is consistent, the shop's ICE on the document", () => {
    expect(agrementIssues(READING, DECLARATION, NOW)).toEqual([]);
  });

  it("leaves a document without ICE, or a reference verified for another shop, to a moderator", () => {
    expect(agrementIssues({ ...READING, ice: "", companyName: "Océan Rent SARL" }, DECLARATION, NOW)).toEqual(["no_ice"]);
    expect(agrementIssues({ ...READING, ice: "", companyName: "Marrakech Car" }, { ...DECLARATION, name: "Marrakech Car Rental Premium" }, NOW)).toEqual(["company"]);
    expect(agrementIssues(READING, { ...DECLARATION, referenceTaken: true }, NOW)).toEqual(["reference_taken"]);
  });

  it("names every doubt", () => {
    expect(agrementIssues({ ...READING, isAgrementDecision: false }, DECLARATION, NOW)).toEqual(["not_agrement"]);
    expect(
      agrementIssues(
        {
          ...READING,
          legible: false,
          reference: "456/2025",
          ice: "",
          companyName: "Atlas Cars",
          decisionDate: "2027-01-01",
          tamperingSigns: ["Date en surimpression"],
          confidence: RENTAL_CHECK_MIN_CONFIDENCE - 0.01,
        },
        DECLARATION,
        NOW,
      ),
    ).toEqual(["unreadable", "reference", "company", "date", "tampering", "low_confidence"]);
    expect(agrementIssues({ ...READING, confidence: Number.NaN }, DECLARATION, NOW)).toEqual(["low_confidence"]);
  });
});

describe("rentalCheckView", () => {
  it("shows the agency its status, dates and the reason of a refusal only", () => {
    const base = { uploadId: "doc1", agrementRef: "123/2025", submittedAt: NOW, issues: ["company" as const], reason: "Le bénéficiaire n'est pas votre société." };
    expect(rentalCheckView({ ...base, status: "review" })).toEqual({ status: "review", submittedAt: NOW.toISOString(), checkedAt: null, method: null, reason: null });
    expect(rentalCheckView({ ...base, status: "rejected", checkedAt: NOW, method: "staff", by: "staff-1" })).toEqual({
      status: "rejected",
      submittedAt: NOW.toISOString(),
      checkedAt: NOW.toISOString(),
      method: "staff",
      reason: base.reason,
    });
  });
});
