/**
 * City labels so emails read "Boston (BOS)" instead of "BOS".
 *
 * This is only a display lookup — what actually gets tracked lives in
 * trips.ts. Codes missing here just render as the bare code.
 */

const CITY_BY_CODE: Record<string, string> = {
  // Departure airports
  BOS: "Boston",
  PVD: "Providence",
  JFK: "New York",
  LGA: "New York",
  EWR: "Newark",
  BDL: "Hartford",
  MHT: "Manchester NH",

  // Destinations
  SJU: "San Juan",
  PUJ: "Punta Cana",
  SDQ: "Santo Domingo",
  STT: "St. Thomas",
  MBJ: "Montego Bay",
  AUA: "Aruba",
};

export function cityFor(code: string): string | undefined {
  return CITY_BY_CODE[code.trim().toUpperCase()];
}

/** "Boston (BOS)", or just "XYZ" for an airport we don't have a name for. */
export function describeAirport(code: string): string {
  const normalized = code.trim().toUpperCase();
  const city = CITY_BY_CODE[normalized];
  return city ? `${city} (${normalized})` : normalized;
}
