// Moroccan airports a car rental agency can serve (rental pack §5): the agency ticks the ones
// where it hands vehicles over. Named on screen by their city and IATA code (`Rental.airport`),
// so no airport name needs its own translation. Client-safe.

export const AIRPORTS = [
  { id: "cmn", citySlug: "casablanca" },
  { id: "rak", citySlug: "marrakech" },
  { id: "aga", citySlug: "agadir" },
  { id: "tng", citySlug: "tanger" },
  { id: "fez", citySlug: "fes" },
  { id: "rba", citySlug: "sale" },
  { id: "esu", citySlug: "essaouira" },
  { id: "ozz", citySlug: "ouarzazate" },
  { id: "ndr", citySlug: "nador" },
  { id: "oud", citySlug: "oujda" },
  { id: "ttu", citySlug: "tetouan" },
  { id: "ahu", citySlug: "al-hoceima" },
  { id: "vil", citySlug: "dakhla" },
  { id: "eun", citySlug: "laayoune" },
  { id: "erh", citySlug: "errachidia" },
  { id: "bem", citySlug: "beni-mellal" },
] as const;

export type AirportId = (typeof AIRPORTS)[number]["id"];
export const AIRPORT_IDS = AIRPORTS.map((airport) => airport.id) as [AirportId, ...AirportId[]];

export function airportById(id: string): (typeof AIRPORTS)[number] | undefined {
  return AIRPORTS.find((airport) => airport.id === id);
}
