# Checkout Continuity

A prototype of a ticket checkout that a fan can start on one surface and finish on another — web to mobile or back — without duplicate orders, without holding stale inventory forever, and without hiding a price change.

The whole thing is one idea: **a checkout session is a coat-check ticket with a timer.** The server holds the seats and owns the clock. A device holds only the claim number. Any surface that presents the number gets the truth, and every attempt to change the truth says which version it last saw.

```
npm install
npm run dev          # http://localhost:3000
npm test             # 31 scenario / concurrency / invariant tests, < 1s
npm run demo         # walks the cross-surface story over the HTTP API (needs the dev server)
```

Then open a listing, start checkout on web, and click **"Open this session on mobile →"**. Use the debug knobs below to change the price, withdraw the listing, or advance the clock while a session is open, and reload either surface.

> Requires Node 20+. Everything is in memory; restarting the server resets the world.

---

## What's here

| Path | What |
|---|---|
| `src/checkout/` | The domain. No framework imports. `types.ts` (state model), `service.ts` (the state machine), `stubs.ts` (inventory / pricing / payments / clock), `invariants.ts` |
| `src/app/api/sessions/` | The HTTP API: create, resume, accept-price, complete, rehold |
| `src/app/checkout/[id]` | Web surface (Server Component) |
| `src/app/m/checkout/[id]` | Simulated mobile surface — same session, phone frame, mobile copy |
| `src/app/deeplink/[id]` | Stand-in for `gametime://checkout/:id`; 302s to the mobile route |
| `src/app/actions.ts` | Server Actions: the web form's transport, thin over the same domain calls |
| `src/app/_components/` | `RecoveryState` (one switch on status), `Countdown`, `PayForm` |
| `src/lib/checkout.ts` | The in-memory singleton, parked on `globalThis` |
| `tests/` | Scenarios 1–16 from the table below, plus concurrency and property tests |
| `scripts/demo.sh` | The story, in curl |
| `docs/decisions.md` | Why each rule is the way it is, with sources |

---

## Assumptions

A take-home doesn't let you ask, so here are the questions I'd have asked and the answer I chose.

| Question | Assumption |
|---|---|
| How long is a hold? Does it shrink near event start? | 10 min; 5 min inside the last hour; 2 min inside the last 15. Always capped at the sales cutoff. It's one policy function (`stubs.ts → policy.holdWindowMs`). |
| Does a price *decrease* need acceptance? | Yes. The invariant "the amount charged is a total the fan saw" is simpler than special-casing decreases. Product could relax it. |
| Can a hold be extended? | No. Longer holds help the holder and hurt everyone else. Documented as a policy knob. |
| Can the fan change quantity mid-session? | No. A session is immutable except status and price; a quantity change is a new session. |
| Does completion need a payment webhook? | In production, yes. Here the stub is awaited, and **reconcile-on-read** stands in for the webhook: a `GET` on a pending session asks the provider. |
| Which surface is canonical for confirmation? | Neither. Any surface that reads a `COMPLETED` session shows the confirmation. |
| What if the listing is withdrawn mid-hold? | The session fails with its own reason and offers similar listings. Seats are never silently swapped. |
| Is payment info portable across surfaces? | No. The session stores no payment details. Each surface collects payment fresh. |
| Who owns a session? | Out of scope. The link is bearer auth — see *Threat model*. |

## Non-goals

No real auth, no real payments, no database, no seat map, no cart, no native app, no push infrastructure. Each would add a day and no continuity signal. The migration path for the ones that matter is in *With more time*.

---

## The state model

```
                    price change → accept-price (stays ACTIVE, priceVersion++)
                    ┌──────────────┐
                    │              │
   create ───────►  ACTIVE ◄───────┘
                      │  │
     now ≥ holdExpiresAt │  └── complete (CAS ok) ───► PAYMENT_PENDING
     or listing withdrawn│                                │        │
                      ▼                        charge ok  │        │ declined / pending timeout
                   EXPIRED                                ▼        ▼
              (or FAILED/INVENTORY_WITHDRAWN)        COMPLETED    FAILED
              (successorSessionId?)                 (orderId)   (failReason, hold released)
```

```ts
CheckoutSession {
  id, listingId, quantity
  quotedTotal, priceVersion      // snapshot at creation; the TOTAL is what's versioned
  holdExpiresAt                  // = min(now + window(timeToEvent), event.salesCutoff)
  status: ACTIVE | PAYMENT_PENDING | COMPLETED | EXPIRED | FAILED
  failReason?: DECLINED | PENDING_TIMEOUT | INVENTORY_WITHDRAWN
  version                        // bumps on every mutation; clients send back what they saw
  paymentIntentId?               // written BEFORE the charge is attempted
  orderId?                       // set exactly once
  idempotency: { [key]: outcome }// replay table
  successorSessionId?            // set when re-held after expiry
  createdOn, lastSeenOn          // telemetry — does NOT bump version
  // never: card, paymentToken, or any payment-method detail
}
```

It's a discriminated union in TypeScript (`src/checkout/types.ts`): a `COMPLETED` session without an `orderId` cannot be constructed, and the UI's switch on status has no `default` branch, so adding a status without handling it is a compile error.

### Five rules that make it work

1. **Expiry is a predicate, not a job.** "Valid" means `ACTIVE && now < holdExpiresAt && listing still backs it`. Nothing has to fire when the deadline passes; the next read turns it into `EXPIRED` and releases the seats. A sweeper would be garbage collection, not correctness.
2. **`PAYMENT_PENDING` is exempt from the clock.** Once a charge is in flight, the hold is frozen. It resolves by payment outcome — or by reconcile-on-read after a pending timeout — never by expiry. Otherwise a seat can be released and resold while the first fan's card is being charged.
3. **Payment has three outcomes, not two.** `ok`, `declined`, and `unknown` (timeout, provider 5xx). Declined is safe to retry. Unknown is not: the UI says "we're confirming — don't retry," and reconcile-on-read settles it. Treating unknown as failed is how fans get charged twice.
4. **The session is the hold.** Inventory and the session are mutated in one synchronous store function. Split them into two stores and you get the crash-between-two-writes bug Shopify wrote up (see `docs/decisions.md`).
5. **Price is a snapshot of the total.** Fees and delivery are part of it. It only changes through an explicit `accept-price`. The amount charged is always a total the fan saw.

---

## The API

Every response — success or rejection — carries `{ session, serverNow, priceChange? }`. Rejections add a machine-readable `code`. A client can always recover by rendering `session`; `code` only picks the copy and the primary action.

```
POST /api/sessions                      { listingId, quantity, surface }         → 201
GET  /api/sessions/:id?surface=          resume; reconciles expiry / withdrawal / pending
POST /api/sessions/:id/accept-price     { version, priceVersion }
POST /api/sessions/:id/complete         { version, priceVersion, idempotencyKey, paymentToken }
POST /api/sessions/:id/rehold           from EXPIRED → a fresh session (idempotent)
```

| Code | HTTP | Meaning |
|---|---|---|
| `NOT_FOUND` | 404 | unknown session |
| `STALE_VERSION` | 409 | client's `version` ≠ server's (ahead *or* behind) |
| `PRICE_CHANGED` | 409 | includes `priceChange {from, to, newPriceVersion}` |
| `EXPIRED` | 409 | hold ended; `session.successorSessionId` if re-held |
| `IN_PROGRESS_ELSEWHERE` | 409 | payment in flight on another surface |
| `ALREADY_COMPLETED` / `ALREADY_FAILED` | 409 | terminal |
| `INVENTORY_WITHDRAWN` | 409 | seller delisted while ACTIVE |
| `SOLD_OUT` | 409 | on create |
| `PAYMENT_DECLINED` | 402 | safe to retry with another method |

**Debug knobs** (dev only): `GET /api/debug/events`, `GET /api/debug/state`, and `POST /api/debug/{advance|price|withdraw|restore|payment|reset}`. `scripts/demo.sh` shows every one in use.

---

## How web and mobile resume the same session

Both surfaces are routes over the same ID and call the same loader (`src/lib/page-data.ts → loadCheckoutPage`). Resume is `GET` + render-by-status. Nothing client-side is authoritative — not local storage, not URL parameters, not which button was pressed.

- **Web** `/checkout/:id` is a Server Component. The session, total, and a correct countdown are in the HTML before JavaScript. Pay is a real `<form>` posting to a Server Action; **it works with JavaScript disabled** (verified in the browser walkthrough). Hydration adds the countdown tick and the button's pending state.
- **Mobile** `/m/checkout/:id` is the same data in a phone frame with shorter, action-first copy. `/deeplink/:id` stands in for the app's universal-link handler and 302s here. The link carries an ID, never state; the page shows a skeleton, fetches, and renders from status.
- **Recovery states** are one component (`RecoveryState.tsx`) with one switch: active, price changed, expired (→ try again, which creates a successor), confirming (unknown payment), completed, declined, withdrawn, pending-elsewhere, and not-found (whose copy must not imply data loss).

### The clock

Every response includes `serverNow`. The countdown's first render is `holdExpiresAt − serverNow` on both server and client, so the HTML and the hydrated tree match. Ticking starts in an effect using a skew computed once from the server's clock. A device that is five minutes fast still shows the right number (verified: 9:57 with `Date.now` shifted +5 min).

### Caching

Checkout routes send `Cache-Control: no-store` (via `next.config.ts`), so the browser can't restore a stale Pay button from the back/forward cache. Note: the dev server stamps its own `no-cache, must-revalidate`; the `no-store` header is what ships under `next build && next start`.

---

## Stale inventory, price changes, duplicate completion

**Duplicate orders — two mechanisms, two jobs.**
- *Different devices* are deduplicated by the **status compare-and-set**: `complete` re-reads the session synchronously after any `await`, checks it's `ACTIVE` with the expected `version`, and flips it to `PAYMENT_PENDING` — all with no `await` in between. The loser sees `IN_PROGRESS_ELSEWHERE` and renders "finishing on your other device."
- *The same device retrying* is deduplicated by the **idempotency key**: minted on the server per page render, carried as a hidden input, stored on the session with its outcome, and replayed. A retry of the same form never charges twice.

The concurrency test (`tests/concurrency.test.ts`) uses a payment stub that yields to the event loop so the two calls genuinely interleave. I verified it fails when the snapshot bug is reintroduced (reading the session *before* the await) — it caught exactly that bug in my first draft.

**Price changes** are checked twice at `complete`: did *this device* see the session's price (`priceVersion` in the body), and is the session's snapshot *still live* (`session.priceVersion == pricing.current().version`)? Checking only the first leaves a window where the price moves after the last GET.

**Stale inventory** comes in two kinds. A hold that *expired* becomes `EXPIRED` on the next read and can be re-held. A listing the seller *withdrew* becomes `FAILED / INVENTORY_WITHDRAWN` even if the hold is unexpired — "valid" is not just "not expired."

**Completion failure**: `paymentIntentId` (= the session ID, used as the provider's idempotency key) is written *before* the charge. If the server dies after charging, the next `GET` asks the provider and reconciles (`payments.nextResult = "lost"` simulates this; scenario 7). If the provider never answers, a pending timeout fails the session and releases the hold.

---

## Scenarios (`npm test`)

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

---

## Instrumentation

Events are structured records with the session ID as the correlation ID across web, mobile and backend: `session_created{surface}`, `session_resumed{surface, fromSurface, ageMs}`, `price_change_accepted`, `payment_started`, `completed`, `session_failed{reason}`, `hold_expired`, `hold_expiring_notified`. `GET /api/debug/events` dumps them.

**The metric** is purchases per *fan who started checkout*, resumed vs. single-surface — not per session, since without continuity a fan starts a second session and per-session conversion undercounts the control. Also worth tracking: time-from-resume-to-complete, and the share of resumes that land on `EXPIRED` (a hold-window tuning signal).

**The honest test** needs a holdout: fans who resume are more motivated, so the raw comparison is biased upward. A feature flag that withholds resume links and notifications for a slice of fans is what gives a causal read.

---

## Tradeoffs

Each of these is expanded, with sources, in `docs/decisions.md`.

- **Same store for hold and inventory** (Shopify's lesson): a hold and the record it guards must commit together.
- **Status CAS + idempotency key**, not a lock (Airbnb / Stripe): the CAS dedupes across devices, the key across retries.
- **Intent written before the charge** (Airbnb's pre-RPC / RPC / post-RPC): a crash after charging is recoverable, not silent.
- **SSR the session, hydrate only what ticks** (Airbnb's Hypernova fallback pattern): the fan gets seats, total and a correct countdown before JS; if SSR failed the page would still client-render.
- **Single status field + version** rather than separate hold and order records with a workflow engine. Right for one session at a time; at scale the hold goes on its own row.
- **Two transports over one domain.** Web posts through Server Actions (progressive enhancement for free); mobile would call the HTTP API. Both are ~6-line adapters. The cost is two entry points for `complete`; the benefit is that the demo shows the same session moving across two real transports.

## Threat model

The link is bearer auth: anyone with the URL can act on the session. IDs are unguessable and carry no PII, but there is no owner check — a signed, short-lived token in the link is the first thing to add. Holds are free inventory denial; a per-client cap on live holds and creation rate limiting need a client identity, which is out of scope here.

## With more time

- Signed session tokens; per-client hold cap; rate limiting.
- Real payment provider with webhook + a reconciliation job (reconcile-on-read already has the shape).
- A database: `version` → `UPDATE … WHERE id=? AND version=?`; the synchronous critical section → a transaction; the event array → an outbox table. The domain doesn't change.
- Hold on its own row so the ledger can be queried independently (`SELECT … FOR UPDATE SKIP LOCKED`).
- SSE so the second surface learns of `COMPLETED` without a refresh.
- A background sweeper for expired holds (garbage collection) and the "hold expiring soon" push, which is stubbed as `notifier.holdExpiringSoon`.
- Universal links / app links with web fallback; deferred deep linking; a minimum-app-version check.

## What took the time

The domain and tests were the first hour and the best hour. Two bugs were found by verification, not by thinking: the concurrency test caught a snapshot-after-await in `complete`, and the production build (not dev) exposed that `instanceof CheckoutError` is false across bundle chunks — Server Actions and the domain are bundled separately, so errors are now identified by a brand, not a class. The UI was the least time. If I had to cut, I'd cut the mobile copy variants before anything in `src/checkout/`.
