# Flight Tracker

A GitHub Action that emails you once a day telling you whether to buy your
flights yet.

Two trips, three departure airports:

| Trip | Dates | From |
|---|---|---|
| **San Juan** (SJU) | Jan 4 – 11, 2027 | BOS · PVD · JFK |
| **Punta Cana** (PUJ) | Mar 7 – 12, 2027 | BOS · PVD · JFK |

**No server, no database, no frontend.** GitHub Actions runs the job, and the
repo *is* the database — each day's prices get committed to `data/prices.csv`,
so history is permanent, diffable, and free. Zero runtime dependencies: the
whole thing is Node's standard library plus `fetch`.

```
  GitHub Actions cron (daily)
        │
        ├─▶ SerpApi ── current fare + Google's low/typical/high
        │
        ├─▶ data/prices.csv ── append today, commit back to the repo
        │
        ├─▶ verdict per route ── BUY NOW / BUY SOON / HOLD / WAIT
        │
        └─▶ Resend ──▶ your inbox
```

---

## Setup

You need three things. **Vercel and Neon are no longer used** — that layer is gone.

### 1. SerpApi (the price data)

Google has no public flights API; the low/typical/high badge comes from an
internal endpoint, and SerpApi is the standard way to reach it.

1. Sign up at [serpapi.com/users/sign_up](https://serpapi.com/users/sign_up)
2. Copy your key from [serpapi.com/manage-api-key](https://serpapi.com/manage-api-key)

**Cost: $0.** Free tier is 250 searches/month. See [Cost](#cost) below — the
current setup uses ~180.

### 2. Resend (the email)

1. Sign up at [resend.com/signup](https://resend.com/signup)
2. Create a key at [resend.com/api-keys](https://resend.com/api-keys)

**No domain needed.** Resend's shared sender (`onboarding@resend.dev`) delivers
to the email address on your own Resend account — exactly this case. Sign up
with the address you want the digest to land in.

### 3. GitHub secrets

Push the repo, then add three repository secrets under
**Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `SERPAPI_KEY` | your SerpApi key |
| `RESEND_API_KEY` | your Resend key |
| `EMAIL_TO` | the email on your Resend account |

Then check **Settings → Actions → General → Workflow permissions** is set to
**Read and write permissions** — the job needs it to commit price history back.

### 4. First run

Go to **Actions → Daily flight check → Run workflow**. Tick *dry* the first
time to poll and save without emailing. If it looks right, run it again
without *dry*.

After that it runs itself at 23:23 UTC daily (≈7:23pm ET).

---

## Running it locally

```bash
cp .env.example .env.local        # add your two keys
node --env-file=.env.local scripts/run.ts --dry
```

| Command | What it does |
|---|---|
| `npm run dry` | Poll + save, print the digest instead of emailing |
| `npm run daily` | The real thing — poll, save, email |
| `npm run offline` | No API calls; rebuild the digest from saved data |
| `npm run preview` | Render a synthetic email to `.preview/email.html` |
| `npm test` | Algorithm regression suite |
| `npm run typecheck` | TypeScript check |

Requires Node 22.18+ (runs `.ts` files directly, no build step).

---

## Cost

Every origin × trip is one API call per day.

**3 origins × 2 trips = 6 calls/day ≈ 180/month**, against SerpApi's free 250.

That leaves room, but not much:

| Setup | Calls/month | Free tier? |
|---|---|---|
| 3 origins × 2 trips (current) | 180 | Yes |
| 4 origins × 2 trips | 240 | Barely |
| 5 origins × 2 trips | 300 | **No** — needs $25/mo |

To change what's tracked, edit `ORIGINS` and `TRIPS` in
[src/lib/trips.ts](src/lib/trips.ts). That's the only file involved.

---

## How the buy indicator works

Six components each score **-1.0 (wait)** to **+1.0 (buy)**, combined as a
weighted average into a -100..+100 score.

| Component | Weight | Measures |
|---|---|---|
| `googlePriceLevel` | 25 | Google's low/typical/high call |
| `historyPercentile` | 20 | Today vs every day logged |
| `typicalRangePosition` | 15 | Where today sits in the typical band |
| `momentum7d` | 15 | 7-day rolling avg vs prior 7 days |
| `deadlinePressure` | 15 | Runway left before departure |
| `momentum30d` | 10 | 30-day rolling avg vs prior 30 days |

**Momentum sign:** rising prices push *toward* buying (window closing), falling
prices push toward waiting.

**Missing data is dropped, not scored as zero.** With no `price_insights`, or
only three days of history, those components are removed and the remaining
weights renormalized. The `confidence` field reports how much of the model was
actually live.

**You get real trends on day one.** The first run backfills ~2 months from
Google's own `price_history`, so 7- and 30-day comparisons work immediately
instead of a month from now.

### Deadline pressure

| Days out | Score | Reading |
|---|---|---|
| > 180 | −0.6 | Very early; fares usually still soften |
| 120–180 | −0.3 | Still early |
| 90–120 | 0.0 | Approaching prime window |
| 60–90 | +0.35 | Inside prime window |
| 21–60 | +0.7 | Window closing, fares climb |
| 14–21 | +0.9 | Last-minute pricing |
| < 14 | +1.0 | Only goes up |

### Runway damping

A "wait" signal is only actionable if there's time to act on it. Inside 60
days, wait-leaning components are progressively damped (to 15% at the end).
Hotels are booked — "don't fly" was never an option, so the only question is
how much you pay.

### Overrides

- **> 200 days out** — capped at `BUY SOON`; fares this early are usually beatable.
- **≤ 21 days out with the 7-day *or* 30-day trend rising** — at least `BUY SOON`.
- **≤ 10 days out** — forced to `BUY NOW`.
- **Record low + Google says "low" + inside 150 days** — forced to `BUY NOW`.

### Trigger price

A concrete number on every card: the lower of Google's typical-band floor and
the 25th percentile of observed prices. See it, book it.

---

## Data

| File | What |
|---|---|
| `data/prices.csv` | The durable series — `route_key,date,price,source`, one row per day per route. Committed daily. |
| `data/latest.json` | Most recent full reading per route: price level, typical band, cheapest offers. |

`source` is `observed` (our own poll) or `google_history` (backfilled from
Google). Reads prefer `observed` and fall back to `google_history` for days the
tracker wasn't running.

Because it's plain CSV in git, `git log -p data/prices.csv` is a full audit
trail of every price change, forever.

---

## Operational notes

- **Scheduled runs can be delayed.** GitHub queues cron workflows; a run may
  fire 5–30 minutes late under load. The schedule uses `:23` rather than `:00`
  to avoid the most congested slot.
- **Public repos: scheduled workflows are disabled after 60 days with no
  repository activity.** The daily price commit counts as activity, so this
  is self-solving — but GitHub emails you before disabling, so don't ignore
  that notice. Private repos aren't subject to it.
- **If the email fails, the run fails** — so a red X in the Actions tab is
  itself the backup alert. Price data is still committed either way.
- **A route that fails to refresh** falls back to its last saved reading, gets
  flagged `stale` on its card, and the error is printed in a banner at the top
  of the email. A stale price can never quietly look like a fresh one.

---

## Project layout

```
flight-tracker/
├── .github/workflows/daily.yml  # the entire "backend"
├── scripts/
│   ├── run.ts                   # poll → save → verdict → email
│   └── preview-email.ts         # render a synthetic email locally
├── src/lib/
│   ├── trips.ts                 # WHAT IS TRACKED — edit this one
│   ├── serpapi.ts               # Google Flights provider
│   ├── store.ts                 # CSV/JSON persistence (the "database")
│   ├── stats.ts                 # rolling windows, percentiles, slope
│   ├── signal.ts                # the buy indicator
│   ├── email.ts                 # digest rendering + Resend
│   └── airports.ts              # city names for readable emails
├── data/                        # committed price history
├── test/                        # regression suite + fixtures
└── python/                      # optional offline backtester (see below)
```

### The Python directory

`python/` is the original CLI, kept as an offline harness for retuning the
algorithm against history without touching the live job. It also generates
`test/fixtures/parity.json`, which `test/parity.test.ts` asserts the
TypeScript engine reproduces exactly — so the scoring logic can't drift
unnoticed:

```bash
python3 python/gen_fixtures.py > test/fixtures/parity.json && npm test
```

Nothing in the daily job depends on it.

---

## Timing

San Juan is ~4 months out; Punta Cana ~6. Expect `WAIT` or `HOLD` for a while —
that's correct, and it's why Google flags some of these "high" right now.

The window that matters is **90–120 days out**: roughly now through October for
San Juan, and November–December for Punta Cana. By the time each decision is
live you'll have months of real history behind the verdict.
