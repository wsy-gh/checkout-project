# Scenarios and instrumentation

Rows 1-27 run against the domain directly, which is where the rules live. Rows 28-47 run
against the route handlers, called as plain functions the way Next.js calls them — that is the
only layer where a status code or a response envelope exists to get wrong. Rows 17-24 are
regression tests: each fails if you remove the fix it covers, which I verified by removing them
one at a time.

| # | Scenario | Forces |
|---|---|---|
| 1 | Create on web → resume on mobile → complete on mobile | fetch-by-ID; events show `fromSurface` |
| 2 | Price rises → resume shows it → complete refused → accept → complete | snapshot, two-comparison check |
| 3 | Clock +11 min → resume is `EXPIRED` → rehold creates successor | implicit expiry, successor link |
| 4 | Two devices complete concurrently | status CAS, no `await` in the critical section |
| 5 | Payment declines | `FAILED/DECLINED`, hold released |
| 6 | Same key retried | replay, one charge |
| 7 | Charge succeeded, response lost → GET reconciles | intent written before charge |
| 8 | Timer hits zero mid-payment | PENDING exempt from expiry |
| 9 | Listing withdrawn while ACTIVE | validity includes "listing still backs it" |
| 10 | Unknown outcome → stays PENDING → times out | three outcomes, pending timeout |
| 11 | Hold near event start capped at cutoff | `min()` with policy function |
| 12 | Deep link for a terminal session | render-from-status, never re-reserve |
| 13 | Unknown ID | 404 path |
| 14 | No client time anywhere in the API | server-owned clock |
| 15 | Client version *ahead* of server | `STALE_VERSION` |
| 16 | Random operation sequences × 8 seeds | invariants in `invariants.ts` hold after every step |
| 17 | Two surfaces reconcile one pending session at once | re-read-after-await in `get`, not just `complete` |
| 18 | A charge lands after the pending timeout already failed the session | terminal states absorb; `reconcile_conflict` logged |
| 19 | One form submitted twice (no JS) | key claimed at the CAS, so it replays instead of racing |
| 20 | A hold nobody re-read | availability evaluates the expiry predicate |
| 21 | `quantity: "abc"` | `INVALID_REQUEST`; the counter is never touched |
| 22 | A declined attempt retried with the same key | same 402, not a silent 200 |
| 23 | Withdrawn listing | the 409 and the page both carry `alternatives[]` |
| 24 | A hold entering its last two minutes | one `hold_expiring_notified`, carrying the deep link |
| 25 | Checkout opened after the sales cutoff | `SALES_CLOSED`, rather than a hold that expired before it began |
| 26 | Money formatting, every cent value to $20,000 | integer cents in, exact two decimals out, locale pinned |
| 27 | Duration formatting across its boundaries | `1h` not `1h 0m`; never a negative duration |
| 28 | Create → resume → complete, three HTTP requests | `201`/`200`/`200`; one session, one order |
| 29 | Every reply carries `session` + `serverNow` + `no-store` | asserted on every response the suite produces |
| 30 | Resume reports the price change in the same reply | one request is enough to draw the screen |
| 31 | `quantity: null` over HTTP | `400` — an absent quantity defaults, a present one never gets coerced |
| 32 | `complete` with no `idempotencyKey` | `400` from the domain, not a silent charge |
| 33 | Stale version, expired hold, second device | `409` `STALE_VERSION` / `EXPIRED` / `IN_PROGRESS_ELSEWHERE` |
| 34 | Rehold when the seats are gone | `409 SOLD_OUT`, and the banner says so on both surfaces |
| 35 | Declined, then the same attempt replayed | `402` both times — a replayed decline is never a `200` |
| 36 | A charge landing after the pending timeout failed the session | `409 ALREADY_FAILED`, not a `200` carrying a `FAILED` session |
| 37 | A body that is not JSON | a `4xx`, never a `500` |
| 38 | Debug knobs under `NODE_ENV=production` | `404` from both handlers; the state is untouched |
| 39 | Every unusable body shape — `null`, `[]`, `"str"`, `42`, garbage | `400`, never a `500`; `null` used to crash on property access |
| 40 | A body over 16 KB | `400` before it is parsed, and nothing held |
| 41 | `quantity` as `true`, `[5]`, `{}`, `Infinity` | `400` — recognised, not coerced; `"2"` still works, since forms send strings |
| 42 | `listingId` as `["L1"]`, `123`, `{}` | `400` — `String(["L1"])` is `"L1"`, which is exactly the problem |
| 43 | `surface` as anything unrecognised, anywhere | treated as absent; never written to the session or the event log |
| 44 | `idempotencyKey` as `{}`, `[1,2]`, 201 chars | `400` — `String({})` collided every such caller onto one key |
| 45 | `paymentToken` omitted | `400`; no default, because the default would charge a placeholder |
| 46 | Unknown fields in an `accept-price` body | ignored; fields are named, not spread |
| 47 | 21 holds in a minute from one caller | `429 RATE_LIMITED`; other callers unaffected; window reopens |

---

## Instrumentation

Events are structured records with the session ID as the correlation ID across web, mobile and backend: `session_created{surface}`, `session_resumed{surface, fromSurface, ageMs}`, `price_change_accepted`, `payment_started`, `completed`, `session_failed{reason}`, `hold_expired`, `hold_expiring_notified{deepLink}`, `reconcile_conflict`. `GET /api/debug/events` dumps them.

`reconcile_conflict` is the one worth alerting on: it means a charge came back successful for a session something else had already failed, so a fan is owed a refund. It is rare by construction and silent without instrumentation, which is exactly the shape of bug that costs money for months.

**The metric** is purchases per *fan who started checkout*, resumed vs. single-surface — not per session, since without continuity a fan starts a second session and per-session conversion undercounts the control. Also worth tracking: time-from-resume-to-complete, and the share of resumes that land on `EXPIRED` (a hold-window tuning signal).

**The honest test** needs a holdout: fans who resume are more motivated, so the raw comparison is biased upward. A feature flag that withholds resume links and notifications for a slice of fans is what gives a causal read.

---
