import { describe, expect, it } from "vitest";
import { completeDates } from "@/components/rental/rental-dates-fields";
import { datedRental } from "@/config/categories";
import { dayNumber, occupiedDays } from "@/lib/listings/rental-availability";
import { toSearchCard } from "@/lib/search/cards";
import { canonicalSearchParams, parseSearchParams } from "@/lib/search/params";
import { buildFilter } from "@/lib/search/service";
import type { CardDocument, FilterExpr } from "@/lib/search/types";

// Holiday homes by dates (seasonal rental conception §2): arrival and departure, the nights between
// them (the departure day stays free), the minimum stay, and the cards' total for the nights.

const NOW = new Date("2026-10-16T12:00:00.000Z");
const STAY = { from: "2026-10-20", to: "2026-10-23" };
const url = (query: string) => parseSearchParams(new URLSearchParams(query));

describe("rentals by dates", () => {
  it("rents cars by the day and homes by the night, nothing else", () => {
    expect(datedRental("location-voitures")).toEqual({ unit: "day", minimum: "min-rental-days" });
    expect(datedRental("location-vacances")).toEqual({ unit: "night", minimum: "min-nights" });
    expect(datedRental("locations")).toBeUndefined();
    expect(datedRental("toString")).toBeUndefined();
    expect(datedRental(null)).toBeUndefined();
  });

  it("occupies every day of a car rental, every night but the departure day of a stay", () => {
    const from = dayNumber(STAY.from);
    expect(occupiedDays(STAY, "day")).toEqual([from, from + 1, from + 2, from + 3]);
    expect(occupiedDays(STAY, "night")).toEqual([from, from + 1, from + 2]);
    expect(occupiedDays({ from: STAY.from, to: STAY.from }, "night")).toEqual([]);
  });
});

describe("stay dates parameters", () => {
  it("reads du/au for holiday homes, one night at least", () => {
    expect(url("sous-categorie=location-vacances&du=2026-10-20&au=2026-10-23").dates).toEqual(STAY);
    expect(url("sous-categorie=location-vacances&du=2026-10-20&au=2026-10-20").dates).toBeUndefined();
    expect(canonicalSearchParams({ subcategory: "location-vacances", dates: STAY }).dates).toEqual(STAY);
    expect(completeDates({ from: "2026-10-20", to: "2026-10-20" }, "night")).toBeUndefined();
    expect(completeDates({ from: "2026-10-20", to: "2026-10-20" })).toEqual({ from: "2026-10-20", to: "2026-10-20" });
    expect(completeDates(STAY, "night")).toEqual(STAY);
  });

  it("keeps homes free every night of the stay whose minimum stay fits", () => {
    const from = dayNumber(STAY.from);
    const filter = buildFilter({ subcategory: "location-vacances", dates: STAY, includeSoldOut: true }, NOW) as { and: FilterExpr[] };
    expect(filter.and.at(-1)).toEqual({
      and: [
        { not: { field: "rentUnavailableDays", op: "in", values: [from, from + 1, from + 2] } },
        { or: [{ field: "a_min_nights", op: "lte", value: 3 }, { not: { field: "a_min_nights", op: "exists" } }] },
      ],
    });
  });

  it("gives a home's card the total of its nights", () => {
    const doc: CardDocument = {
      id: "h1",
      slugId: "riad-h1",
      title: "Riad",
      subcategoryId: "location-vacances",
      price: 800,
      priceNegotiable: false,
      isDonation: false,
      citySlug: "marrakech",
      photoCount: 1,
      sellerType: "pro",
      sortAt: NOW.getTime(),
      isBumped: false,
      rentFreshUntil: NOW.getTime() + 1000,
    };
    expect(toSearchCard(doc, NOW, false, STAY).rental).toEqual({ days: 3, total: 2400, fresh: true, from: STAY.from, to: STAY.to });
  });
});
