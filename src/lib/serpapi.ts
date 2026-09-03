/**
 * SerpApi Google Flights client.
 *
 * Source of the low/typical/high classification. SerpApi proxies Google
 * Flights and exposes `price_insights`:
 *
 *   { lowest_price, price_level, typical_price_range: [lo, hi],
 *     price_history: [[unix_ts, price], ...] }
 */

const ENDPOINT = "https://serpapi.com/search.json";

export class ProviderError extends Error {
  override name = "ProviderError";
}

export interface Offer {
  price: number;
  airline: string;
  flightNumbers: string;
  stops: number;
  totalDuration: number | null;
  departureTime: string | null;
  arrivalTime: string | null;
}

export interface FetchResult {
  lowestPrice: number | null;
  avgPrice: number | null;
  medianPrice: number | null;
  nOffers: number;
  priceLevel: string | null;
  typicalLow: number | null;
  typicalHigh: number | null;
  /** Google's own daily history, already converted to YYYY-MM-DD. */
  history: { date: string; price: number }[];
  offers: Offer[];
}

export interface FetchParams {
  origin: string;
  destination: string;
  outboundDate: string;
  returnDate: string | null;
  adults?: number;
  currency?: string;
  travelClass?: number;
  stops?: number;
  apiKey?: string;
  signal?: AbortSignal;
}

interface RawLeg {
  departure_airport?: { name?: string; id?: string; time?: string };
  arrival_airport?: { name?: string; id?: string; time?: string };
  airline?: string;
  flight_number?: string;
}

interface RawItinerary {
  flights?: RawLeg[];
  layovers?: { duration?: number; id?: string }[];
  total_duration?: number;
  price?: number;
}

function parseOffer(item: RawItinerary): Offer | null {
  if (typeof item.price !== "number") return null;
  const legs = item.flights ?? [];
  const first = legs[0];
  const last = legs[legs.length - 1];
  const airlines = [...new Set(legs.map((l) => l.airline).filter(Boolean))] as string[];

  return {
    price: item.price,
    airline: airlines.join(", "),
    flightNumbers: legs.map((l) => l.flight_number ?? "").filter(Boolean).join(", "),
    stops: Math.max(legs.length - 1, 0),
    totalDuration: item.total_duration ?? null,
    departureTime: first?.departure_airport?.time ?? null,
    arrivalTime: last?.arrival_airport?.time ?? null,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export async function fetchRoute(params: FetchParams): Promise<FetchResult> {
  const apiKey = params.apiKey ?? process.env.SERPAPI_KEY;
  if (!apiKey) throw new ProviderError("SERPAPI_KEY is not set");

  const query = new URLSearchParams({
    engine: "google_flights",
    api_key: apiKey,
    departure_id: params.origin,
    arrival_id: params.destination,
    outbound_date: params.outboundDate,
    type: params.returnDate ? "1" : "2",
    currency: params.currency ?? "USD",
    hl: "en",
    gl: "us",
    adults: String(params.adults ?? 1),
    travel_class: String(params.travelClass ?? 1),
    stops: String(params.stops ?? 0),
    deep_search: "true",
  });
  if (params.returnDate) query.set("return_date", params.returnDate);

  let response: Response;
  try {
    response = await fetch(`${ENDPOINT}?${query}`, {
      signal: params.signal,
      headers: { "User-Agent": "flight-tracker/1.0" },
    });
  } catch (cause) {
    throw new ProviderError(`Could not reach SerpApi: ${(cause as Error).message}`);
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new ProviderError(`SerpApi HTTP ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (payload.error) throw new ProviderError(`SerpApi error: ${String(payload.error)}`);

  const best = (payload.best_flights as RawItinerary[]) ?? [];
  const other = (payload.other_flights as RawItinerary[]) ?? [];
  const offers = [...best, ...other]
    .map(parseOffer)
    .filter((o): o is Offer => o !== null)
    .sort((a, b) => a.price - b.price);

  const prices = offers.map((o) => o.price);
  const insights = (payload.price_insights as Record<string, unknown> | undefined) ?? {};
  const typical = (insights.typical_price_range as [number, number] | undefined) ?? [null, null];

  if (prices.length === 0 && Object.keys(insights).length === 0) {
    throw new ProviderError(
      `No flights and no price insights for ${params.origin}->${params.destination} ` +
        `on ${params.outboundDate}. Check the airport codes and that the date is inside ` +
        `the airlines' bookable window (~11 months).`,
    );
  }

  const rawHistory = (insights.price_history as [number, number][] | undefined) ?? [];
  const history: { date: string; price: number }[] = [];
  for (const entry of rawHistory) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [ts, price] = entry;
    if (typeof ts !== "number" || typeof price !== "number") continue;
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    history.push({ date, price: Math.round(price) });
  }

  return {
    lowestPrice:
      (insights.lowest_price as number | undefined) ?? (prices.length ? prices[0]! : null),
    avgPrice: prices.length
      ? Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 100) / 100
      : null,
    medianPrice: prices.length ? Math.round(median(prices) * 100) / 100 : null,
    nOffers: prices.length,
    priceLevel: (insights.price_level as string | undefined) ?? null,
    typicalLow: typical[0] ?? null,
    typicalHigh: typical[1] ?? null,
    history,
    offers: offers.slice(0, 8),
  };
}
