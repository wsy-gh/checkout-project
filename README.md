# Checkout Continuity

A fan starts buying tickets on their laptop, gets interrupted, and finishes on their phone —
without being charged twice, without seats being held forever, and without a price change
slipping past them.

The whole design follows from one decision: **the server owns everything, and a device holds
nothing but an ID.** Seats, price, and the deadline all live in one record on the server. A
browser is given that record's ID and nothing else. "Resuming on your phone" is then not a
feature that needs building — the phone asks about the same ID and gets the same answer,
because the server was the only thing that ever knew.

```
npm install
npm run dev     # http://localhost:3000
npm test        # 66 tests, under a second
npm run demo    # the whole story over the HTTP API, in curl (needs the dev server running)
```

Start a checkout on web, then click **"Open this session on mobile ↗"**, which opens a second
tab so you can watch one session live in two places. Each checkout page has a dev-only
**session inspector** that explains the three fields the whole thing runs on, with something
to try for each. The debug knobs change the price, pull the listing, or move the clock
forward underneath both tabs.

> Node 20+. Everything is in memory, so restarting the server resets the world.

### Reading order

The code is commented to be read start to finish. This order works best:

| | |
|---|---|
| [`src/checkout/types.ts`](src/checkout/types.ts) | What a session is. Start here — the rest makes more sense once you know the shape. |
| [`src/checkout/service.ts`](src/checkout/service.ts) | Every rule in the app. The header explains why this file is so careful about `await`. |
| [`src/checkout/invariants.ts`](src/checkout/invariants.ts) | The things that must never stop being true, checked on every write. |
| [`tests/concurrency.test.ts`](tests/concurrency.test.ts) | The races, genuinely interleaved rather than described. |
| [`tests/api.test.ts`](tests/api.test.ts) | The HTTP contract: status codes, the envelope, `no-store`. |
| [`docs/decisions.md`](docs/decisions.md) | Why each rule is the way it is, with sources. |

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
   or listing pulled  │                            │              │
                      ▼                  charge ok │              │ declined, or no answer
                   EXPIRED                         ▼              ▼   for too long
              (or FAILED)                      COMPLETED       FAILED
```

A session is declared in [`types.ts`](src/checkout/types.ts) as a set of alternatives rather
than one type with optional fields, so a completed session always has an order ID and a
failed one always has a reason. Those combinations are not "checked" anywhere — they simply
cannot be built.

Five rules do most of the work:

1. **A hold expires by being noticed, not by a timer.** Nothing runs in the background. A
   session is expired the moment somebody reads it after its deadline, which means there is
   never a gap where the clock has passed but the cleanup hasn't run. The one thing this
   misses is the seat *count*, which only finds out when someone reads the session — and
   nobody ever reads the session of a fan who closed their tab. So anything that displays or
   consumes seat counts checks the deadlines first.
2. **A payment in flight ignores the clock.** Once a charge has started, the deadline stops
   applying. Otherwise the timer could hand the seats to someone else while the first fan's
   card was being charged, and sell the same seats twice. A payment ends when the provider
   says so.
3. **A charge has three outcomes, not two.** It worked, it was declined, or *we don't know*.
   A declined card is safe to retry because no money moved. A timeout is not, because it may
   have. Telling someone "that failed, try again" when we don't actually know is how people
   get billed twice.
4. **The seats and the session are written together.** One function, no pausing in the
   middle. Keep them in separate systems and a crash between the two writes leaves seats that
   nobody holds and nobody can buy.
5. **The price the fan sees is the price they pay.** A quote never updates silently. If the
   listing's price moves, the fan is shown both numbers and has to accept the new one.

## The API

Every response carries the full session, whether the request succeeded or not. That means a
client never has to ask a second question to find out where it stands — it can always just
redraw from what it was handed. Failures add a short code that picks the wording and the
button, nothing more.

```
POST /api/sessions                    { listingId, quantity, surface }              → 201
GET  /api/sessions/:id?surface=        resume: read it, and bring it up to date
POST /api/sessions/:id/accept-price   { version, priceVersion }
POST /api/sessions/:id/complete       { version, priceVersion, idempotencyKey, paymentToken }
POST /api/sessions/:id/rehold          start a fresh session after one expired
```

`INVALID_REQUEST` 400 · `NOT_FOUND` 404 · `PAYMENT_DECLINED` 402 · and 409 for
`STALE_VERSION`, `PRICE_CHANGED`, `EXPIRED`, `IN_PROGRESS_ELSEWHERE`, `ALREADY_COMPLETED`,
`ALREADY_FAILED`, `INVENTORY_WITHDRAWN` (which brings other listings with it), `SOLD_OUT`,
`SALES_CLOSED`.

The rule behind that table: `complete` answers 2xx only when the session it hands back is the
result of *this* attempt — paid, or still confirming. A session that ended for some other
reason, such as the pending timeout writing it off while the charge was in flight, goes out as
a 409. A 200 carrying a `FAILED` session is a success to every client that checks the status
code before reading the body. [`tests/api.test.ts`](tests/api.test.ts) pins each row, along
with the envelope and `no-store`, by calling the route handlers directly — no server, no port.

Dev-only knobs, used throughout `scripts/demo.sh`: `GET /api/debug/{events,state}` and
`POST /api/debug/{advance,price,withdraw,restore,payment,reset}`. "Dev-only" is enforced, not
just labelled — both handlers answer 404 when `NODE_ENV=production`, because one unauthenticated
POST to `/reset` would end every fan's checkout at once. Run the demo against `npm run dev`.

## How web and mobile share one session

Both surfaces are URLs over the same ID and call the same loader
([`page-data.ts`](src/lib/page-data.ts)). Resuming is a read, and what gets drawn is decided
by one switch on the session's status with no fallback branch — add a status and the build
breaks until someone decides what the fan should see. Nothing on the device is authoritative:
not local storage, not the URL, not which button was pressed.

`/deeplink/:id` stands in for the link that would open a native app. There is no loading
spinner because there is nothing to wait for — the page is rendered on the server, so the
first thing a deep link paints is already the answer. Each surface has its own "not found"
page so the wording fits, and neither implies the fan lost anything. One caveat I measured
rather than assumed: Next.js sends a 404 for a missing session with an empty page and fills
it in with JavaScript, so that single screen is not readable before JS. Keeping the honest
status code seemed the better trade for a page with no state and no clock on it.

The only client-side coordination is
[`SessionSync`](src/app/_components/SessionSync.tsx), and it stores nothing and decides
nothing — every path through it ends in "ask the server again". It covers three ways a page
goes stale: the browser restoring a frozen copy on Back, an in-app Back landing on a cached
screen, and a second tab being further ahead than this one.

## The four things that go wrong

**Two devices, or one device asking twice.** These look the same and need opposite answers.
Two devices are two real attempts: the first flips the session to "paying" and the second is
told so. One device sending the same attempt twice — a double-click, a retried request — is
one attempt, and the second copy should get the first one's answer rather than a second
charge. The status check handles the first case and can't handle the second; the idempotency
key handles the second and can't handle the first. Hence both.

The same care is needed when *reading*, which is the half that's easy to miss. Checking on a
payment means calling the provider, which means pausing, which means the session may have
changed by the time the answer comes back. Two tabs refreshing a pending payment at once
would otherwise each hand the seats back — a listing with four seats ending up with six.
[`tests/concurrency.test.ts`](tests/concurrency.test.ts) has that scenario, and it fails if
the guard is removed.

**The price moved.** Checked twice when paying: did this screen see the price the session is
holding, and is that price still the real one? The first alone leaves a gap — the fan loads
the page, the seller changes the price, the fan presses Pay, and nothing about the session
has changed so nothing looks wrong.

**The seats went away.** Two different things, deliberately kept apart. A hold that *ran out*
becomes expired and can be started again. A listing the seller *pulled* becomes a failure
even though the hold was still good, and comes with other listings attached so the fan isn't
left at a dead end. "Still valid" means more than "not expired yet".

**The payment didn't resolve.** The payment's ID is written down before the charge is
attempted, so if this server died one line later the next read can ask the provider what
happened to it. A charge that throws is "we don't know" rather than a failure: the seats stay
held and the fan is told not to retry. A timeout eventually writes the session off, and if a
late success then arrives for a session already written off, that gets logged as owing
somebody a refund.

## Timing, money, and what renders before JavaScript

The checkout page is rendered on the server, so the event, seats, total and a correct
countdown are all in the first HTML. Pay is a real form that posts to the server, so it works
before React loads and with JavaScript switched off entirely. `Cache-Control: no-store` on
checkout pages, confirmed under `next build && next start` — the dev server sends a weaker
header of its own.

**Clocks.** Everything sent over the wire is a plain timestamp, and everything shown on
screen is a *length of time* between two of them. No time of day is ever displayed, which is
why nothing here needs to know what timezone anyone is in, and why flying across several
changes nothing. Timers count using `performance.now()`, which only moves forward at a steady
rate, rather than re-reading the clock. Changing timezone doesn't move the clock — but a
phone re-syncing when it lands does, and a timer doing arithmetic on that would visibly
lurch. It also keeps counting while a tab is in the background, so a throttled timer catches
up instead of drifting.

**Money** is whole cents everywhere, so the usual floating-point problems never arise —
multiplying a price by a quantity is integers all the way. The one division happens when
drawing it on screen, through `Intl.NumberFormat` with the locale fixed so the server and the
browser can't format the same number differently. That it's exact is asserted rather than
assumed: a test checks every cent value up to $20,000.

## Tradeoffs

[`docs/decisions.md`](docs/decisions.md) has one entry per decision — what was chosen, why,
what it costs, and the engineering write-up it came from. The load-bearing ones: seats and
sessions live in the same store because they have to be written together; two devices are
separated by a status check and one device retrying by an idempotency key, because neither
mechanism can do the other's job; and the payment's ID is written before the charge, so a
crash after charging is recoverable rather than silent.

## Security

The link is the credential: anyone with the URL can act on the session. IDs are unguessable
and carry no personal information, but there is no check that the person holding the link is
the person who started the checkout — a signed, short-lived token would be the first thing to
add. Holds also cost nothing to create, so someone could take seats off the market in bulk; a
per-person limit and rate limiting are the fix, and both need a notion of who someone is,
which is out of scope here.

The debug knobs are the one thing here that would be actively dangerous deployed, so they are
closed structurally rather than by intention: `NODE_ENV=production` makes both handlers 404, and
a test asserts it. Unauthenticated routes that reset all state or move the server's clock are
not something to leave reachable and trust nobody to find.

## With more time

Signed session tokens, a per-person hold limit, rate limiting. A real payment provider, with
webhooks and a job that reconciles against it. A database — the version counter becomes
`UPDATE … WHERE id = ? AND version = ?`, the uninterrupted section becomes a transaction, and
nothing in `src/checkout/` changes. Push updates instead of polling, and a real scheduler for
the "your hold is running out" notice, which is wired up but has nothing to fire it while the
clock is a stub.

## What took the time

The state machine and its tests were the first hour and the best hour. Every bug that
mattered was found by checking rather than by thinking, and two of them taught the same
lesson from opposite directions.

A concurrency test caught a stale read in the pay path. Fixing it made me confident about
writes — and that confidence was itself the bug, because the *read* path pauses in exactly
the same way and had no such guard. Separately, "a hold expires by being noticed" was true of
the session and false of the seat count, because a plain counter has no way to notice
anything. Both times I was right about the part I had tested and wrong about the part I
hadn't.

The UI took the least time. If I had to cut something, the mobile wording variants would go
first, and nothing in `src/checkout/` would go at all.
