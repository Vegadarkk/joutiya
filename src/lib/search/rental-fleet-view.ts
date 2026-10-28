import { criterionById } from "@/config/categories";
import { dayNumber, moroccoToday } from "@/lib/listings/rental-availability";
import { rentalDayRate } from "@/lib/listings/rental";
import { RENTAL_SEARCH_AHEAD_DAYS, RENTAL_SEARCH_DAYS_MAX, rentalDuration, type RentalDates } from "./params";
import type { SearchDocument, SearchPhoto } from "./types";

// The fleet of a car rental agency's storefront (rental pack §5): each vehicle with what its card
// and the on-page date filter need, and the agency's conditions summed up from its listings.
// Built on the server from the search index (rental-fleet.ts), filtered in the browser: the dates
// and the branch city narrow the grid without a request. Client-safe, pure.

export interface FleetVehicle {
  id: string;
  slugId: string;
  title: string;
  /** MAD per day; null when the listing has none. */
  price: number | null;
  citySlug: string | null;
  photo: SearchPhoto | null;
  photoCount: number;
  rentalClass: string | null;
  gearbox: string | null;
  fuel: string | null;
  seats: number | null;
  minDays: number | null;
  rate7: number | null;
  rate30: number | null;
  /** Blocked day numbers within the search horizon (pick-up within 180 days, 60 days of rental). */
  blocked: number[];
  /** Availability confirmed within 14 days (decision 4: the others read « à confirmer »). */
  fresh: boolean;
  example: boolean;
}

export interface FleetConditions {
  /** Youngest driver age any vehicle accepts, and the shortest licence seniority. */
  minAge: number | null;
  licenceYears: number | null;
  /** MAD; null when no vehicle declares one. */
  deposit: { min: number; max: number } | null;
  /** Declared options, in the criterion's order. */
  insurance: string[];
  handover: string[];
  oneWay: boolean;
}

export interface RentalFleetView {
  vehicles: FleetVehicle[];
  /** Rentals the agency has online (the grid may show fewer). */
  total: number;
  conditions: FleetConditions;
}

/** Index fields the fleet reads (attributesToRetrieve). */
export const FLEET_FIELDS = [
  "id",
  "slugId",
  "title",
  "price",
  "citySlug",
  "photo",
  "photoCount",
  "isExample",
  "rentUnavailableDays",
  "rentFreshUntil",
  "a_rental_class",
  "a_gearbox",
  "a_fuel",
  "a_seats",
  "a_min_rental_days",
  "a_rate_7_days",
  "a_rate_30_days",
  "a_driver_min_age",
  "a_licence_years",
  "a_rental_deposit",
  "a_rental_insurance",
  "a_vehicle_handover",
  "a_one_way",
] as const satisfies readonly (keyof SearchDocument)[];

export type FleetDocument = Partial<Pick<SearchDocument, (typeof FLEET_FIELDS)[number]>> & Pick<SearchDocument, "id" | "slugId" | "title">;

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : []);

/** Options of a select criterion in its declared order, kept when present in `values`. */
function ordered(criterionId: string, values: Set<string>): string[] {
  const criterion = criterionById(criterionId);
  const options = criterion && "options" in criterion ? (criterion.options as readonly string[]) : [];
  return options.filter((option) => values.has(option));
}

export function toFleetVehicle(doc: FleetDocument, now: Date): FleetVehicle {
  const today = moroccoToday(now);
  const last = today + RENTAL_SEARCH_AHEAD_DAYS + RENTAL_SEARCH_DAYS_MAX;
  const photo = doc.photo ? { id: doc.photo.id, w: doc.photo.w, h: doc.photo.h, blurhash: doc.photo.blurhash } : null;
  return {
    id: doc.id,
    slugId: doc.slugId,
    title: doc.title,
    price: num(doc.price),
    citySlug: str(doc.citySlug),
    photo,
    photoCount: Number.isInteger(doc.photoCount) ? (doc.photoCount as number) : photo ? 1 : 0,
    rentalClass: str(doc.a_rental_class),
    gearbox: str(doc.a_gearbox),
    fuel: str(doc.a_fuel),
    seats: num(doc.a_seats),
    minDays: num(doc.a_min_rental_days),
    rate7: num(doc.a_rate_7_days),
    rate30: num(doc.a_rate_30_days),
    blocked: (doc.rentUnavailableDays ?? []).filter((day) => day >= today && day <= last).sort((a, b) => a - b),
    fresh: typeof doc.rentFreshUntil === "number" && doc.rentFreshUntil > now.getTime(),
    example: doc.isExample === true,
  };
}

export function fleetConditions(docs: readonly FleetDocument[]): FleetConditions {
  const ages = docs.map((doc) => num(doc.a_driver_min_age)).filter((value): value is number => value !== null);
  const licences = docs.map((doc) => num(doc.a_licence_years)).filter((value): value is number => value !== null);
  const deposits = docs.map((doc) => num(doc.a_rental_deposit)).filter((value): value is number => value !== null);
  return {
    minAge: ages.length ? Math.min(...ages) : null,
    licenceYears: licences.length ? Math.min(...licences) : null,
    deposit: deposits.length ? { min: Math.min(...deposits), max: Math.max(...deposits) } : null,
    insurance: ordered("rental-insurance", new Set(docs.flatMap((doc) => strings(doc.a_rental_insurance)))),
    handover: ordered("vehicle-handover", new Set(docs.flatMap((doc) => strings(doc.a_vehicle_handover)))),
    oneWay: docs.some((doc) => doc.a_one_way === true),
  };
}

export function toRentalFleet(docs: readonly FleetDocument[], total: number, now: Date): RentalFleetView {
  return { vehicles: docs.map((doc) => toFleetVehicle(doc, now)), total, conditions: fleetConditions(docs) };
}

/** Free on every day from pick-up to return, both included, and the minimum rental fits (as the search filter). */
export function vehicleAvailable(vehicle: Pick<FleetVehicle, "blocked" | "minDays">, dates: RentalDates): boolean {
  const from = dayNumber(dates.from);
  const to = dayNumber(dates.to);
  if (vehicle.minDays !== null && vehicle.minDays > rentalDuration(dates)) return false;
  return !vehicle.blocked.some((day) => day >= from && day <= to);
}

/** Estimated total for the period, long-term rate applied; null without a day price. */
export function vehicleTotal(vehicle: Pick<FleetVehicle, "price" | "rate7" | "rate30">, dates: RentalDates): number | null {
  if (vehicle.price === null) return null;
  const days = rentalDuration(dates);
  const attributes = { ...(vehicle.rate7 !== null ? { "rate-7-days": vehicle.rate7 } : {}), ...(vehicle.rate30 !== null ? { "rate-30-days": vehicle.rate30 } : {}) };
  return rentalDayRate(attributes, vehicle.price, days) * days;
}

/** Dates the fleet filter applies at `now`: a pick-up from today to 180 days ahead, at most 60 days of rental. */
export function fleetDates(dates: Partial<RentalDates>, now: Date | number): RentalDates | null {
  if (!dates.from || !dates.to) return null;
  const from = dayNumber(dates.from);
  const to = dayNumber(dates.to);
  const today = moroccoToday(now);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from || to - from > RENTAL_SEARCH_DAYS_MAX) return null;
  return from >= today && from <= today + RENTAL_SEARCH_AHEAD_DAYS ? { from: dates.from, to: dates.to } : null;
}
