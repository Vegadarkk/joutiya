import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { RentalFleet, type FleetLabels } from "@/components/rental/rental-fleet";
import { RentalAgencyCard, RentalBranches, RentalConditions } from "@/components/rental/rental-storefront";
import { formatPrice } from "@/lib/listings/client/format";
import { dayNumber, dayString, moroccoToday } from "@/lib/listings/rental-availability";
import { rentalAgencySchema } from "@/lib/pro/profile-schema";
import { fleetConditions, fleetDates, toFleetVehicle, toRentalFleet, vehicleAvailable, vehicleTotal, type FleetDocument } from "@/lib/search/rental-fleet-view";

// The fleet of a car rental agency's storefront (rental pack §5): index documents to vehicles
// (blocked days within the search horizon, freshness), the conditions summed up, the in-place
// date filter, and the agency settings schema (decision 3: the licence reference).

const NOW = new Date("2026-10-16T12:00:00.000Z");
const TODAY = moroccoToday(NOW);

function doc(id: string, overrides: Partial<FleetDocument> = {}): FleetDocument {
  return {
    id,
    slugId: `voiture-${id}`,
    title: `Voiture ${id}`,
    price: 300,
    citySlug: "marrakech",
    photoCount: 0,
    a_rental_class: "berline",
    a_gearbox: "manuelle",
    a_fuel: "diesel",
    a_seats: 5,
    rentFreshUntil: NOW.getTime() + 1,
    ...overrides,
  };
}

const LABELS: FleetLabels = {
  classes: [
    { id: "citadine", label: "Citadine" },
    { id: "berline", label: "Berline" },
  ],
  gearbox: { manuelle: "Manuelle", automatique: "Automatique" },
  fuel: { diesel: "Diesel", essence: "Essence" },
};

describe("fleet vehicles", () => {
  it("keep the blocked days of the search horizon, sorted, and tell the freshness", () => {
    const vehicle = toFleetVehicle(doc("a", { rentUnavailableDays: [TODAY + 300, TODAY + 3, TODAY - 2, TODAY + 1, TODAY + 240] }), NOW);
    expect(vehicle.blocked).toEqual([TODAY + 1, TODAY + 3, TODAY + 240]);
    expect(vehicle).toMatchObject({ rentalClass: "berline", gearbox: "manuelle", fuel: "diesel", seats: 5, minDays: null, fresh: true, example: false, photo: null });
    expect(toFleetVehicle(doc("b", { rentFreshUntil: NOW.getTime() }), NOW).fresh).toBe(false);
    expect(toFleetVehicle(doc("c", { rentFreshUntil: undefined, price: undefined }), NOW)).toMatchObject({ fresh: false, price: null });
  });

  it("are free when no day from pick-up to return is blocked and the minimum fits", () => {
    const from = dayString(TODAY + 10);
    const vehicle = { blocked: [TODAY + 13], minDays: 3 };
    expect(vehicleAvailable(vehicle, { from, to: dayString(TODAY + 12) })).toBe(false); // 2 days < 3
    expect(vehicleAvailable(vehicle, { from, to: dayString(TODAY + 13) })).toBe(false); // return day blocked
    expect(vehicleAvailable({ ...vehicle, blocked: [TODAY + 9, TODAY + 14] }, { from, to: dayString(TODAY + 13) })).toBe(true);
  });

  it("estimate the total with the long-term rate", () => {
    const vehicle = { price: 300, rate7: 250, rate30: null };
    expect(vehicleTotal(vehicle, { from: "2026-10-20", to: "2026-10-23" })).toBe(900);
    expect(vehicleTotal(vehicle, { from: "2026-10-20", to: "2026-10-27" })).toBe(1750);
    expect(vehicleTotal({ ...vehicle, price: null }, { from: "2026-10-20", to: "2026-10-23" })).toBeNull();
  });

  it("apply dates from today to 180 days ahead, 60 days of rental at most", () => {
    expect(fleetDates({ from: "2026-10-20" }, NOW)).toBeNull();
    expect(fleetDates({ from: "2026-10-15", to: "2026-10-17" }, NOW)).toBeNull();
    expect(fleetDates({ from: "2026-10-20", to: "2026-10-19" }, NOW)).toBeNull();
    expect(fleetDates({ from: "2026-10-20", to: dayString(dayNumber("2026-10-20") + 61) }, NOW)).toBeNull();
    expect(fleetDates({ from: "2026-10-16", to: "2026-10-16" }, NOW)).toEqual({ from: "2026-10-16", to: "2026-10-16" });
  });
});

describe("fleet conditions", () => {
  it("sum up the youngest driver, the deposit range, insurance and handover in the criteria order", () => {
    const conditions = fleetConditions([
      doc("a", { a_driver_min_age: 23, a_licence_years: 2, a_rental_deposit: 8000, a_rental_insurance: "tous-risques-franchise", a_vehicle_handover: ["livraison", "agence"] }),
      doc("b", { a_driver_min_age: 21, a_licence_years: 3, a_rental_deposit: 3000, a_rental_insurance: "rc", a_vehicle_handover: ["aeroport"], a_one_way: true }),
      doc("c"),
    ]);
    expect(conditions).toEqual({
      minAge: 21,
      licenceYears: 2,
      deposit: { min: 3000, max: 8000 },
      insurance: ["rc", "tous-risques-franchise"],
      handover: ["agence", "aeroport", "livraison"],
      oneWay: true,
    });
    expect(fleetConditions([doc("d")])).toEqual({ minAge: null, licenceYears: null, deposit: null, insurance: [], handover: [], oneWay: false });
  });
});

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );

describe("storefront fleet", () => {
  it("groups the fleet by category in the criterion's order, then the others", () => {
    const fleet = toRentalFleet([doc("b1"), doc("c1", { a_rental_class: "citadine", a_gearbox: "automatique", a_fuel: "essence", a_seats: 4 }), doc("x1", { a_rental_class: undefined, rentFreshUntil: undefined })], 3, NOW);
    const html = render(<RentalFleet fleet={fleet} labels={LABELS} shopPublicId="abcdefgh23" mediaBaseUrl={null} locale="fr" />);
    const classes = [...html.matchAll(/data-class="([^"]+)"/g)].map((match) => match[1]);
    expect(classes).toEqual(["citadine", "berline", "_other"]);
    expect(html).toContain("3 véhicules en location");
    expect(html).toContain("Automatique");
    expect(html).toContain("4 places");
    expect(html).toContain("Autres véhicules");
    // A vehicle whose availability is older than 14 days reads « à confirmer ».
    expect(html.match(/Disponibilité à confirmer/g)).toHaveLength(1);
    // Search links: the shop's fleet and the other agencies.
    expect(html).toContain("boutique=abcdefgh23");
    expect(html).not.toContain("data-status=");
  });

  it("shows the agency's declared licence, hours, payments, airports and branches", () => {
    const rental = rentalAgencySchema.parse({
      agrementRef: "AGR 123/2025",
      branches: [{ citySlug: "marrakech", address: "Avenue Mohammed VI, Guéliz" }],
      hours: "Tous les jours, 8 h - 21 h",
      payments: ["cash", "transfer"],
      airports: ["rak", "aga"],
    });
    const card = render(<RentalAgencyCard rental={rental} locale="fr" />);
    expect(card).toContain("AGR 123/2025");
    expect(card).toContain("déclaré par l&#x27;agence");
    expect(card).toContain("Espèces, Virement");
    expect(card).toContain("Marrakech (RAK), Agadir (AGA)");
    const branches = render(<RentalBranches rental={rental} locale="fr" />);
    expect(branches).toContain("Avenue Mohammed VI, Guéliz");
    expect(render(<RentalBranches rental={{ ...rental, branches: [] }} locale="fr" />)).toBe("");
  });

  it("states the conditions, nothing when none is declared", () => {
    const html = render(<RentalConditions conditions={{ minAge: 21, licenceYears: 2, deposit: { min: 3000, max: 8000 }, insurance: ["rc"], handover: ["aeroport"], oneWay: true }} locale="fr" />);
    expect(html).toContain("dès 21 ans · permis depuis 2 ans");
    expect(html).toContain(`Caution de ${formatPrice(3000, "fr")} à ${formatPrice(8000, "fr")}`);
    expect(html).toContain("retour dans une autre ville possible");
    expect(render(<RentalConditions conditions={{ minAge: null, licenceYears: null, deposit: null, insurance: [], handover: [], oneWay: false }} locale="fr" />)).toBe("");
  });
});

describe("rental agency settings", () => {
  const base = { agrementRef: "123/2025", branches: [], hours: "", payments: [], airports: [] };
  it("needs a licence reference with a digit, known airports and no duplicates", () => {
    expect(rentalAgencySchema.safeParse(base).success).toBe(true);
    expect(rentalAgencySchema.safeParse({ ...base, agrementRef: " AGR-12 " }).data?.agrementRef).toBe("AGR-12");
    for (const agrementRef of ["12", "abc", "-123", "123/", "x".repeat(40) + "1", "١٢٣٤"]) expect(rentalAgencySchema.safeParse({ ...base, agrementRef }).success, agrementRef).toBe(false);
    expect(rentalAgencySchema.safeParse({ ...base, airports: ["xyz"] }).success).toBe(false);
    expect(rentalAgencySchema.safeParse({ ...base, payments: ["card", "card"] }).success).toBe(false);
    const branch = { citySlug: "agadir", address: "Founty, Agadir" };
    expect(rentalAgencySchema.safeParse({ ...base, branches: Array(6).fill(0).map((_, i) => ({ ...branch, address: `${branch.address} ${i}` })) }).success).toBe(false);
    expect(rentalAgencySchema.safeParse({ ...base, branches: [branch, { ...branch, address: "FOUNTY, AGADIR" }] }).success).toBe(false);
  });
});
