import { getTranslations } from "next-intl/server";
import { approximatePosition, cityBySlug, cityName, regionByCode, regionName } from "@/config/regions";
import { MapToggle } from "./map-toggle";
import { StaticRegionsMap, type StaticRegionsMapProps } from "./static-regions-map";

// One-stop map block for the listing page (Server Component): the static map, wrapped in the toggle that
// loads the interactive map on demand. The approximate position is computed once here and shared with
// both maps, so they never disagree.
//
//   <ListingMapBlock citySlug={listing.location.citySlug} seed={listing.id} locale={locale} />

export async function ListingMapBlock({ citySlug, seed, locale, regionCode, className }: StaticRegionsMapProps) {
  const city = cityBySlug(citySlug);
  const region = regionByCode(regionCode ?? city?.regionCode ?? "");
  const staticMap = <StaticRegionsMap citySlug={citySlug} seed={seed} locale={locale} regionCode={regionCode} />;
  if (!city || !region) return <div className={className}>{staticMap}</div>;
  const t = await getTranslations({ locale, namespace: "Map" });
  return (
    <MapToggle center={approximatePosition(city, seed)} description={t("approximate", { city: cityName(city, locale), region: regionName(region, locale) })} className={className}>
      {staticMap}
    </MapToggle>
  );
}
