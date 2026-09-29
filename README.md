# Checkout Continuity

A fan starts buying tickets on their laptop, gets interrupted, and finishes on their phone —
without being charged twice, without seats being held forever, and without a price change
slipping past them.

The whole design follows from one decision: **the server owns everything, and a device holds
no session state.** Seats, price, and the deadline all live in one record on the server. A
browser is given that record's ID (in the URL) and, in a cookie, an anonymous id for itself —
and nothing else; neither is authoritative over any seat, price, or deadline. "Resuming on your
phone" is then not a feature that needs building — the phone asks about the same ID and gets the
same answer, because the server was the only thing that ever knew. The cookie is a separate
concern: it lets the server recognise one browser across its own repeated attempts, so a single
browser can't drain a listing by starting the same checkout over and over. It is a convenience,
not a credential — there is no auth here, so possession of the link is the only authorisation.

```
npm install
npm run dev     # http://localhost:3000
npm test        # 95 tests, under a second
npm run demo    # the whole story over the HTTP API, in curl (needs the dev server running)
```

Start a checkout on web, then click **"Open this session on mobile ↗"**, which opens a second
tab on the same route with `?surface=mobile` so you can watch one session live in two places.
Each checkout page has a dev-only **session inspector** that explains the three fields the whole
thing runs on, with something to try for each. The debug knobs change the price, pull the
listing, or move the clock forward underneath both tabs.

> Node 20+. Everything is in memory, so restarting the server resets the world.

### Reading order

The code is commented to be read start to finish. This order works best:

| | |
|---|---|
| [`src/checkout/types.ts`](src/checkout/types.ts) | What a session is. Start here — the rest makes more sense once you know the shape. |
| [`src/checkout/service.ts`](src/checkout/service.ts) | Every rule in the app. |
| [`src/checkout/invariants.ts`](src/checkout/invariants.ts) | Processing rules for the app |
| [`tests/concurrency.test.ts`](tests/concurrency.test.ts) | The race condition tests. |
| [`tests/api.test.ts`](tests/api.test.ts) | The HTTP contract. |
| [`docs/tradeoffs.md`](docs/tradeoffs.md) | Why each rule is the way it is. |

Also: [assumptions and non-goals](docs/assumptions.md) · [scenario list](docs/scenarios.md)

---

## The state model

```
                    price changes → fan accepts it (stays ACTIVE, new price recorded)
                    ┌──────────────┐
                    │              │
   create ───────►  ACTIVE ◄───────┘
                      │  │
      deadline passes │  └── fan pays ──────────► PAYMENT_PENDING
      or fan releases │                            │              │
   or listing pulled  ▼                  charge ok │              │ declined, or no answer
                   EXPIRED                         ▼              ▼   for too long
              (or FAILED)                      COMPLETED       FAILED
```


Five rules do most of the work:

1. **A hold expires by being read, not by a timer.** Nothing runs in the background. A
   session is expired the moment somebody reads it after its deadline, which means there is
   never a gap where the clock has passed but the cleanup hasn't run. The one thing this
   misses is the seat *count*, which only finds out when someone reads the session — and
   nobody ever reads the session of a fan who closed their tab. So anything that displays or
   consumes seat counts checks the deadlines first.
2. **A payment in flight ignores the clock.** Once a charge has started, the deadline stops
   applying. Otherwise the timer could hand the seats to someone else while the first fan's
   card was being charged, and sell the same seats twice. The pending payment ends when the payment provider
   says so.
3. **A charge has three outcomes, not two.** It worked, it was declined, or *we don't know*.
   A declined card is safe to retry because no money moved. A timeout is not, because it may
   have completed. Telling someone "that failed, try again" when we don't actually know is how people
   get billed twice.
4. **The seats and the session are written together.** One function, no pausing in the
   middle. Keep them in separate systems and a crash between the two writes leaves seats that
   nobody holds and nobody can buy.
5. **The price the fan sees is the price they pay.** A quote never updates silently. If the
   listing's price moves, the fan is shown both numbers and has to accept the new one.

## The API

```
POST /api/sessions                    { listingId, quantity, surface }              → 201
GET  /api/sessions/:id?surface=        resume: read it, and bring it up to date
POST /api/sessions/:id/accept-price   { version, priceVersion }
POST /api/sessions/:id/complete       { version, priceVersion, idempotencyKey, paymentToken }
POST /api/sessions/:id/cancel          give up the hold now; seats back on sale immediately
POST /api/sessions/:id/rehold          start a fresh session after one expired
```

**Every response about a session carries that full session, success or failure**, so a client
never needs a second request to find out where it stands — it redraws from what it was handed.
Failures add a code that picks the wording and the button. The only replies that carry a code
alone are the ones not about a particular session: `NOT_FOUND`, `INVALID_REQUEST`, and the
create-time `SOLD_OUT` / `SALES_CLOSED` / `INVENTORY_WITHDRAWN`.

`INVALID_REQUEST` 400 · `NOT_FOUND` 404 · `PAYMENT_DECLINED` 402 · and 409 for
`STALE_VERSION`, `PRICE_CHANGED`, `EXPIRED`, `IN_PROGRESS_ELSEWHERE`, `ALREADY_COMPLETED`,
`ALREADY_FAILED`, `INVENTORY_WITHDRAWN` (which brings other listings with it), `SOLD_OUT`,
`SALES_CLOSED`.

The rule behind that table: **`complete` answers 2xx only when the session it returns is the
result of *this* attempt** — paid, or still confirming. A session that ended for an unrelated
reason, such as the pending timeout writing it off while the charge was in flight, goes out as a
409, because a 200 carrying a `FAILED` session reads as success to every client that checks the
status code before the body.

Bodies are read inside `respond`, so a malformed one is a 400 rather than a 500; they cap at
16 KB; and anything parsing to a non-object (`null`, `[]`, a bare string) counts as no fields.

[`tests/api.test.ts`](tests/api.test.ts) pins every row above, plus the envelope and `no-store`,
by calling the route handlers directly — no server, no port.

Dev-only knobs, used throughout `scripts/demo.sh`: `GET /api/debug/{events,state}` and
`POST /api/debug/{advance,price,withdraw,restore,payment,reset}`. "Dev-only" is enforced rather
than labelled — both handlers answer 404 when `NODE_ENV=production`, because one unauthenticated
POST to `/reset` would end every fan's checkout at once.

## How web and mobile share one session

Both surfaces are the same route over the same ID and call the same loader
([`load-checkout-page.ts`](src/lib/load-checkout-page.ts)). `/checkout/:id` is the page and
`?surface=mobile` re-dresses it in a phone frame; there is no second route. Resuming is a read,
and what gets drawn is decided by one switch on the session's status with no fallback branch —
add a status and the build breaks until someone decides what the fan should see.

Nothing on the device is authoritative: not local storage, not which button was pressed, not the
URL, and not the `cid` (client ID) cookie, which names the browser for hold dedup but decides nothing about a
session. `surface` URL query param picks a stylesheet
and a wording variant to represent device e.g., desktop, mobile, native, and an unrecognised value falls back to web.

`/deeplink/:id` stands in for the link that would open a native app. There is no loading spinner
because there is nothing to wait for: the page is rendered on the server, so the first thing a
deep link paints is already the answer. The checkout route has one "not found" page shared by
both surfaces — Next.js renders it without the `surface`, so it cannot differ — worded so it
never implies the fan lost anything.

Since auth was not in the scope of the takehome, two conveniences use the `cid` cookie to reconnect a returning browser to its own hold. Visiting
bare `/checkout` (no ID) redirects to that browser's live hold, or shows an "Empty checkout" page
with a way back to the listings. And opening a stale `/checkout/:id` link whose hold has since
**expired** — an old history entry or bookmark — redirects to a live hold the same browser still
has, preferring one for the same listing, which is the usual case: they re-held and this is the
successor. Both are cookie-scoped, so a browser is only ever sent to a session that is genuinely
its own; a different visitor opening the same expired link still sees the expired screen. Neither
is a way to *discover* a session without the cookie or the link.

The only client-side coordination is
[`SessionSync`](src/app/_components/SessionSync.tsx), and it stores nothing and decides
nothing — every path through it ends in "ask the server again". It covers three ways a page
goes stale: the browser restoring a frozen copy on Back, an in-app Back landing on a cached
screen, and a second tab being further ahead than this one.

## The four things that go wrong

**Two devices, or one device asking twice.** These look the same and need opposite answers. Two
devices are two real attempts: the first flips the session to "paying" and the second is told so (handled by a status check).
One device sending the same attempt twice — a double-click, a retried request — is one attempt,
and the second copy should get the first one's answer rather than a second charge (handled by an idempotency key). 

The same care is needed when *reading*, which is the half that's easy to miss. Checking on a
payment means calling the payment provider, which means pausing, which means the session may have changed by the time the answer comes back. Two tabs refreshing a pending payment at once would otherwise
each hand the seats back — a listing with four seats ending up with six.
[`tests/concurrency.test.ts`](tests/concurrency.test.ts) has that scenario, and it fails if the guard is removed.

**The price moved.** Checked twice when paying: did this screen see the price the session is
holding, and is that price still the real one? The first alone leaves a gap — the fan loads the
page, the seller changes the price, the fan presses Pay, and nothing about the session has changed
so nothing looks wrong.

**The seats went away.** A hold that *ran out*
becomes expired and can be started again. A listing the seller *pulled* becomes a failure even
though the hold was still good, and comes with other listings attached so the fan isn't left at a
dead end. "Still valid" means more than "not expired yet".

**The payment didn't resolve.** The payment's ID is written down before the charge is attempted,
so if this server died one line later the next read can ask the provider what happened to it. A
charge that throws is "we don't know" rather than a failure: the seats stay held and the fan is
told not to retry.

A payment nobody answers for cannot be left holding its seats forever, so resolving it does not
wait on the original fan coming back. `sweepExpired` — already the thing that frees lapsed holds,
run by every `create` and every page that shows seat counts — also reconciles a pending payment
past its timeout, so the seats a walked-away fan was holding go back for the next buyer. And a
failed session keeps the payment's reference (`unresolvedIntentId`) so a *later* read can ask
again: a charge we had written off that turns out to have landed is refunded and the conflict
recorded, rather than the money vanishing silently. Both paths have regression tests.

## Tradeoffs

[`docs/tradeoffs.md`](docs/tradeoffs.md) has one entry per decision — what was chosen, why, and
what it costs. The load-bearing ones:

- **Seats and sessions share one store**, because they have to be written together; split across
  two systems, a crash between the writes leaves seats nobody holds and nobody can buy.
- **The payment's ID is written before the charge**, so a crash after charging is recoverable
  rather than silent.

## With more time

**User can cancel a hold / clear a checkout** Cancel feature that can remove a hold or trash checkout.

**Possibly supporting the purchasing of more than one event.** Currently you can only purchase ticket(s) for one event at a time. Upon starting the check for another event, your current checkout tickets will be surrendered. Most ticketing services don't do this, so this is optional.

**Observability.** The app already emits a structured event for everything that matters —
`session_created`, `session_resumed`, `payment_started`, `completed`, `hold_expired`,
`hold_released_by_fan`, `reconcile_conflict`, `refund_issued` — but they go to an in-memory list read by
`GET /api/debug/events`. That list is the seam: pointed at a real sink, those events are the
funnel this project exists to measure (how many resumes happen, on which surface, how long after
the first visit, how many holds lapse without a payment) and the alerts you actually want
(`reconcile_conflict` and `refund_issued` should be rare, so a rate above zero is a page). Missing
alongside it: error tracking on the server with the session ID attached, so a failure in the wild
arrives with the state it happened to rather than as a stack trace alone; a metric on pending
payments still unresolved past their timeout, which is the leading indicator for a provider
problem; and client-side reporting for the one class of bug the server cannot see, a page whose
hydration fails.

**Auth, and the two things that hang off it.** Signed session tokens, so possession of a link is
no longer sufficient. Then a per-person cap on concurrent holds — the anonymous cookie handles
the accidental repeat-the-flow case today, but a cap that survives a cookie wipe needs a real
account — and **rate limiting** on hold creation. An earlier version rate-limited by IP address,
but an IP is a guess (shared behind one office router, changed with a tap), so it was removed
rather than shipped as protection that doesn't hold; done properly it belongs at the edge, keyed
to a real identity.

**A translation layer.** The fan-facing wording is inline in the components and English-only. It
reads slightly differently on web and mobile, so the natural next step is a small `t(locale, …)`
layer that keeps those two variants and adds languages — whole phrases with the value inside
(`Accept ${total}`) so a translator can reorder them, and `Intl.PluralRules` for counts, rather
than string concatenation that bakes in English word order.

**A real payment provider**, with webhooks and a scheduled reconciliation job; the
`payments.refund` and reconcile-on-read paths here are the shape of it, stubbed. **A database** —
the version counter becomes `UPDATE … WHERE id = ? AND version = ?`, the uninterrupted section
becomes a transaction, and nothing in `src/checkout/` changes. **Push updates** instead of
polling, and a real scheduler for the "your hold is running out" notice, which is wired up but has
nothing to fire it while the clock is a stub.

**One-click quantity changes.** Picking a new quantity on a listing you already hold returns your
existing hold, because the per-browser dedup cannot tell "I meant to start over" from "I pressed Back
twice". So changing quantity is two steps: **Release these seats**, then start again. Having `create`
swap the hold instead — "latest quantity wins" — is about twenty lines in one place, but it needs two
things it does not have: an availability reader on the inventory interface, so a swap that cannot fit
refuses *before* destroying the hold the fan already had, and a listing page that counts the fan's own
held seats back into its quantity picker, since today those seats are missing from `available` and a
fan holding all of them sees "these seats are gone" with no form at all. The explicit release is the
honest version — nothing is destroyed until the fan says so, and there is no path that loses a hold to
a failed swap — so the one-click form stays future work rather than a shortcut taken early.

**Browser-level tests.** Using Playwright.
