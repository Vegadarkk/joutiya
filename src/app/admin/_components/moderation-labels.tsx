import "server-only";
import { criterionById } from "@/config/categories";
import { cityBySlug, cityName, regionByCode, regionName } from "@/config/regions";
import { loadMessages } from "@/i18n/messages";
import type { ListingAttributes } from "@/lib/contracts/listings";

// French labels of the catalogue for the back office (the admin host has no next-intl provider):
// categories, criteria and their options, places, conditions, listing statuses.

type Tree = { [key: string]: string | Tree };

function at(tree: Tree, ...path: string[]): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const key of path) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
  }
  return typeof node === "string" ? node : undefined;
}

const number = new Intl.NumberFormat("fr-FR");

export interface CatalogLabels {
  category(categoryId: string | null, subcategoryId: string | null): string;
  place(citySlug: string | null, regionCode?: string | null): string;
  criterion(id: string): string;
  value(id: string, value: ListingAttributes[string]): string;
  condition(value: string): string;
  status(status: string): string;
}

export async function catalogLabels(): Promise<CatalogLabels> {
  const messages = (await loadMessages("fr")) as unknown as Tree;
  const option = (id: string, value: string) => at(messages, "Criteria", id, "options", value) ?? value;
  return {
    category(categoryId, subcategoryId) {
      if (!categoryId) return "Sans catégorie";
      const name = at(messages, "Categories", categoryId, "name") ?? categoryId;
      const sub = subcategoryId ? (at(messages, "Categories", categoryId, "sub", subcategoryId) ?? subcategoryId) : null;
      return sub ? `${name} › ${sub}` : name;
    },
    place(citySlug, regionCode) {
      const city = citySlug ? cityBySlug(citySlug) : undefined;
      const region = regionByCode(regionCode ?? city?.regionCode ?? "");
      if (!city) return "Lieu non renseigné";
      return region ? `${cityName(city, "fr")}, ${regionName(region, "fr")}` : cityName(city, "fr");
    },
    criterion: (id) => at(messages, "Criteria", id, "label") ?? id,
    value(id, value) {
      if (Array.isArray(value)) return value.map((item) => option(id, item)).join(", ");
      if (typeof value === "boolean") return value ? "Oui" : "Non";
      if (typeof value === "number") {
        const unit = criterionById(id)?.unit;
        const label = unit ? at(messages, "Listing", "units", unit) : undefined;
        return label ? `${number.format(value)} ${label}` : number.format(value);
      }
      return option(id, value);
    },
    condition: (value) => at(messages, "Criteria", "condition", "options", value) ?? value,
    status: (status) => at(messages, "Listing", "status", status) ?? status,
  };
}

/** "il y a 3 heures" from an ISO date. */
export function waitingFor(isoDate: string, now = new Date()): string {
  const minutes = Math.round((new Date(isoDate).getTime() - now.getTime()) / 60_000);
  const format = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

export function formatPrice(price: number | null, isDonation: boolean): string {
  if (isDonation) return "Don";
  if (price === null) return "Prix à discuter";
  return `${number.format(price)} DH`;
}
