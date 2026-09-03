/**
 * Everything being watched. This is the only file you edit to change what
 * gets tracked.
 *
 * Cost: every origin × trip combination is one SerpApi call per day.
 * 3 origins × 2 trips = 6 calls/day ≈ 180/month, against a 250/month free tier.
 */

export interface Trip {
  id: string;
  label: string;
  destination: string;
  outboundDate: string;
  returnDate: string | null;
}

export interface Route extends Trip {
  key: string;
  origin: string;
}

/** Departure airports, checked for every trip below. */
export const ORIGINS = ["BOS", "PVD", "JFK"] as const;

/** Sorted soonest-first; the email keeps this order. */
export const TRIPS: Trip[] = [
  {
    id: "sju",
    label: "San Juan",
    destination: "SJU",
    outboundDate: "2027-01-04",
    returnDate: "2027-01-11",
  },
  {
    id: "puj",
    label: "Punta Cana",
    destination: "PUJ",
    outboundDate: "2027-03-07",
    returnDate: "2027-03-12",
  },
];

/** Search parameters applied to every lookup. */
export const SEARCH = {
  adults: 2,
  currency: "USD",
  /** 1=economy 2=premium economy 3=business 4=first */
  travelClass: 1,
  /** 0=any 1=nonstop only 2=<=1 stop 3=<=2 stops */
  stops: 0,
} as const;

export function routeKey(
  origin: string,
  destination: string,
  outboundDate: string,
  returnDate: string | null,
): string {
  const base = `${origin}-${destination}-${outboundDate}`;
  return returnDate ? `${base}-${returnDate}` : base;
}

/** The full cross product of origins × trips, in email display order. */
export function allRoutes(): Route[] {
  return TRIPS.flatMap((trip) =>
    ORIGINS.map((origin) => ({
      ...trip,
      origin,
      key: routeKey(origin, trip.destination, trip.outboundDate, trip.returnDate),
    })),
  );
}
