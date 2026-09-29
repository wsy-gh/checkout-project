# Tradeoffs

One entry per decision that shaped the code: what was chosen, why, and what it costs. Written for
someone who knows the problem and is new to this codebase.

---

### 1. The hold and the inventory are written together

A session *is* the hold: `create` takes units from inventory and writes the session in one
synchronous function, `release` returns them and writes the terminal state in one.

With holds in one store (Redis with a TTL) and inventory in another (MySQL), no single transaction
covers both, and a crash between the two writes leaves them disagreeing — either stock is hidden that
is available, or stock is sold that is gone. Changing the write order only changes which failure you
get.

**Cost.** In production the hold table sits next to the ledger and takes the write load. One row per
reservable unit with `SELECT … FOR UPDATE SKIP LOCKED` is the usual answer, which for tickets is free:
a seat already is one row.

### 2. Expiry is a predicate, not a job — and PAYMENT_PENDING is exempt

"Valid" is `ACTIVE && now < holdExpiresAt && the listing still backs it`, evaluated on every read.
Nothing fires when the deadline passes. A pending session is never expired by the clock; it resolves
by payment outcome or by a timeout that consults the provider.

A timer-based release can free a seat while the first fan's card is mid-charge — a double sell.
Making the deadline a property of the row, and exempting the in-flight state, removes the race and
the need for a correctness-critical background job at once. A sweeper becomes garbage collection.

**Cost.** A pending session can hold a seat past the window while a provider is slow; the pending
timeout bounds it.

### 3. Availability still has to be asked

`create` and the pages showing seat counts `await sweepExpired(listingId)` first.

"Expiry is noticed on read" was true of session *status* and false of *availability*: seats are
decremented at `create` and only returned when somebody reads the session — and nobody reads the
session of a fan who closed the tab, so a listing's last seat could be held forever. The fix keeps
the thesis by moving the evaluation to the read that actually cares: not the departed fan's, the next
fan's.

**Cost.** `create` and those pages are async and may call the provider during the sweep. Against a
database the lapsed-hold half is just `WHERE expires_at > now()` in the availability query.

### 4. Two dedup mechanisms, because neither can do the other's job

*Different devices* are separated by a compare-and-set on status: re-read the session, check it is
`ACTIVE` at the expected `version`, flip to `PAYMENT_PENDING`, no `await` in between. *One device's
retry* is separated by a client-carried idempotency key, stored with its outcome and replayed.

A key cannot stop two devices, which hold different keys. A CAS cannot help a retry, which arrives
after the first attempt flipped the status and would be told "in progress elsewhere" about its own
request.

**Cost.** The key must be minted once per attempt and reused on retry — here once per server render,
carried as a hidden input. The replay table is a plain object, so the lookup uses `Object.hasOwn`: a
key like `"constructor"` would otherwise match an inherited property and a first-ever attempt with
that name would be refused as a replay of nothing.

### 5. The re-read-after-await rule applies to reads, not just writes

`settle` takes a session *id*, re-reads it, and returns early if the status is no longer pending.
Every caller reaches it only after awaiting the provider, so the session it held is a snapshot.

`complete` was careful about this and `get` was not — the more dangerous half, since reconcile-on-read
is the path an ordinary page load takes and the pending screen tells the fan to refresh. Two surfaces
refreshing one pending session each settled it independently: three concurrent reads each
released onto a 4-seat listing, leaving it with 8, and concurrent `ok` settlements minted two
order ids. Concurrency bugs hide in the read
path precisely because reads feel safe.

The guard is a status check rather than a version check because status is monotone — `ACTIVE` only at
`create`, `PAYMENT_PENDING` only from `ACTIVE`, the terminal states absorbing — so "is it still
pending?" is a compare-and-set. That monotonicity is a property of the transition table rather than
the types, so `assertTransition` asserts it on every write, along with the rule that a write must
advance the version: the general detector for this bug class, since a write built from a pre-`await`
snapshot cannot produce a version the store has not already passed.

**Cost.** One settlement wins, the other is dropped. When the dropped one carries `ok` — our charge
succeeded on a session the timeout already failed — a refund is owed, so it calls `payments.refund`
and emits `reconcile_conflict` + `refund_issued` rather than failing silently.

### 6. Payment is three-phase, with the intent written before the call

`complete` (a) flips to `PAYMENT_PENDING` and writes `paymentIntentId` — the session id, which
doubles as the provider's idempotency key — (b) calls the provider, (c) records the outcome. Reading a
pending session asks the provider about that intent and reconciles.

If the server dies between (b) and (c) the fan was charged and the session is stuck. Because the
intent was recorded in (a), the next read can ask "what happened to intent X?" and land on COMPLETED
or FAILED rather than a dead end. In production this is a webhook plus a reconciliation job;
reconcile-on-read has the same shape.

**Cost.** `get` is async, which is what forces the re-read rule above.

### 7. Three payment outcomes: ok, declined, unknown

A decline fails the session and releases the hold; `unknown` keeps it pending and the screen says
"we're confirming — don't retry".

A timeout is not a decline. The idempotency key protects the *same* request, but a fan told "payment
failed, try again" re-enters a card and creates a *new* one — the double charge the whole design
exists to prevent. So only a decline unlocks retry.

**Cost.** One more enum value, one more recovery screen, and a pending timeout so `unknown` cannot
hang forever.

### 8. A charge we never heard back from is `unknown`, not an error

`complete` catches a throwing `payments.charge` and treats it as `unknown`, leaving the session
pending with its intent recorded.

A transport failure says nothing about whether the card was charged, which is exactly what `unknown`
means. Letting it propagate produced a 500 and an error page — the one screen that invites a fan to
re-enter their card — and the hold must not be released on a charge that may have landed.

**Cost.** A genuine crash is indistinguishable from a provider timeout here, though an in-memory
store loses everything on a crash anyway, so the distinction was never real.

### 9. Abandoned payments are reconciled without a background job

`sweepExpired` also reconciles a pending session past its timeout and re-checks a failed session
still carrying an `unresolvedIntentId`. A charge that turns out to have landed on a written-off
session is refunded and recorded; the reference is cleared once resolved, so it fires exactly once.

Two gaps in "expiry is noticed on read". A pending payment the buyer walked away from held its seats
until someone read *that* session, which nobody does after closing the tab. And once the timeout
failed the session, reads stopped consulting the provider, so a charge confirmed afterwards vanished
unrefunded — leaving the on-screen "refunded automatically" promise unbacked.

**Cost.** The refund is a stub; a real system also reconciles against the provider on a schedule.

### 10. Price is a snapshot, changed only by explicit acceptance

`quotedTotal` and `priceVersion` are frozen at creation. `complete` refuses unless the request's
`priceVersion` matches the session *and* the session's matches the live price. `accept-price` is the
only way to move the snapshot, decreases included.

"The amount charged is a total the fan saw" is simple to state, test and explain. Checking only the
client's `priceVersion` leaves a window where the price moves after the last read; the second
comparison closes it.

**Cost.** A price decrease costs the fan one more click. Auto-applying decreases is a one-line change.

### 11. A read from another surface does not bump `version`

`lastSeenOn` is updated on resume without bumping `version`; only substantive changes do.

`version` is the concurrency counter, so if a mere read from the phone invalidated the laptop's
version, a fan who glanced at the app would have their web Pay rejected for no reason they could
understand. Telemetry must not masquerade as state.

**Cost.** None — this fell out of the tests, where a cross-surface resume followed by a complete was
failing with `STALE_VERSION`.

### 12. Server-render the session; hydrate only what ticks

The checkout page is a Server Component, so the session, total and a countdown seeded from `serverNow`
are in the first HTML. The countdown ticks in an effect measuring elapsed time with
`performance.now()`, restarting whenever a re-fetch supplies a fresh `serverNow`. Pay is a `<form>`
posting to a Server Action, so it works before hydration and with JavaScript off.

The fan is under time pressure: the first paint must be actionable and the number right regardless of
the device's clock. Ticking during the initial render would be a hydration mismatch (server 9:58,
client 9:55), so the browser's first render measures zero elapsed time and matches exactly.
`performance.now()` because a phone re-syncs its clock on landing and a countdown doing arithmetic on
that lurches; anchoring to `serverNow` is what stops a re-fetched page counting the same seconds twice.

**Cost.** Server Actions and Route Handlers are two transports over one domain, so `complete` has two
small adapters. They are also bundled separately in production, which makes `instanceof CheckoutError`
false across that boundary — errors carry a brand property instead. Found by the production build, not
by dev.

### 13. Recognise input, never coerce; validate in the domain

Values from outside go through three functions in `src/lib/input.ts` that return the value only if it
already has the right type, and `undefined` otherwise. Shape rules that hold regardless of transport
are checked in `service.ts` rather than the routes.

`String(["L1"])` is `"L1"` and `Number(true)` is `1`, so a `String(x)`/`Number(x)` "check" always
succeeds and turns an invalid request into a plausible-looking valid one. And with two front doors —
the HTTP API and the Server Actions — a rule enforced in only one is not enforced.

All of this was found by pointing curl at a running server rather than by reading: a body of literal
`null` crashed `create` (`JSON.parse("null")` succeeds and is not an object), `{"quantity": true}`
bought a ticket, `?surface=<script>` was stored verbatim. Each was a coercion or a cast standing in
for a check.

**Cost.** Hand-written checks rather than a schema library. A real service would declare each shape
once and derive both the type and the runtime check so the two cannot drift.

### 14. One checkout route; the surface is a query parameter

A single page, `/checkout/:id`, where `?surface=mobile` selects the phone frame and shorter wording.
An earlier version had a second route at `/m/checkout/:id`; the two files were ~28 lines each and
differed in three — a wrapper element, a label, a surface string.

One page makes the project's own claim literal rather than merely true: one loader, one screen, the
surface only choosing how it is dressed. Putting the surface in the URL is not a hole in "nothing on
the device is authoritative" — authority is seats, price and deadlines, all read from the session —
and an unrecognised surface falls back to web.

**Cost.** `not-found.tsx` cannot see the surface, so the 404 wording is shared.

### 15. Session ids are unguessable

A short prefix plus a UUIDv7, with the timestamp from the injected clock so a fast-forwarding test
gets ids consistent with its own timeline. They were `cs_0001`, `cs_0002`.

With no auth, possession of the link is the only authorisation, so a guessable id makes the whole
store walkable by counting. v7 rather than v4 so ids sort by creation time, keeping database index
inserts at one end — irrelevant in memory, but annoying to reverse once ids reach a database and
other systems' logs.

**Cost.** Ids are no longer readable in the demo; the inspector and `GET /api/debug/state` carry them.

### 16. A per-browser hold dedup, so one browser cannot drain a listing

The server gives each browser an anonymous id in an `httpOnly` `cid` cookie. `create` takes an
optional `clientId` and, if that browser already has a live session for the listing, returns it
instead of holding new seats. The Server Action mints and sets the cookie; the JSON API reads one if
present but never sets it; the home page reads it to scope the resume banner.

The idempotency key prevents a duplicate *payment within one session* and does nothing about
duplicate *holds across sessions*, so one browser repeating Buy → Start → Back reserved fresh seats
each time and could take a listing's whole inventory without paying. A cookie rather than
`localStorage` (sent with every request, set server-side, `httpOnly` so script cannot forge it) or a
device fingerprint (unreliable and privacy-hostile).

Two conveniences build on the same cookie: bare `/checkout` redirects to that browser's live hold or
shows an empty state, and a stale `/checkout/:id` link whose hold expired redirects to a live hold the
browser still has, preferring the same listing (the usual re-hold successor). Both are cookie-scoped,
so a browser is only ever sent to its own session.

**Cost.** Not a security control — clearing the cookie or calling the API without one yields a fresh
identity — so it closes only the accidental flow; a durable per-person cap needs real auth. Resuming
ignores a newly-picked quantity, which is what entry 22 exists to give the fan a way out of. `create` gains a scan over the listing's
sessions, which against a database is an indexed lookup on `(client_id, listing_id)`. Per-browser, so
cross-device continuity is untouched. The two page-level redirects were verified by hand rather than
in the unit suite, since they need `cookies()`, `redirect()` and a real request scope; the
`resumable(clientId)` filter underneath them is unit-tested.

### 17. One process, checked rather than assumed

The store is a `Map` on `globalThis`, so `src/lib/checkout.ts` refuses to start if Node reports it is
a cluster worker, and `GET /api/debug/state` reports a per-process `instanceId`.

The no-`await`-between-read-and-write guarantee holds within one process and says nothing about two.
Two processes would not race — each has its own `Map` and cannot see the other's sessions — so the
failure is total rather than subtle, which the check turns into a refusal to boot rather than half the
sessions served to half the users. The `instanceId` covers what the check cannot: a serverless
platform running many isolated instances, none of them a cluster worker.

**Cost.** None for a single-process run. The real fix is a shared store; the migration is the
`UPDATE … WHERE version = ?` and the transaction described in entry 5.

### 18. Singletons reset in place, never swapped

Route Handlers and Server Components are separate module graphs in the dev server, so a module that
imported `checkout` before a reset kept the old instance while newly compiled modules got the new one
— sessions created through the API were "not found" by the page. `resetAll()` therefore rebuilds
state in place and never assigns new instances.

**Cost.** Stub state has to sit behind one object so it can be rebuilt in place.

### 19. Rate limiting removed rather than shipped half-working

An earlier version rate-limited `POST /api/sessions` by IP. It ran only in the API route, not the
Server Action or `rehold`, so the same caller the API refused could still create holds through the
form — the claimed protection did not hold. And keying on IP is a guess: shared behind one router,
changed with a tap. Bounding bulk hold creation is worth doing, but properly it belongs at the edge
keyed to a real identity, which needs the auth this prototype lacks. Protection that reads as real
but is not is worse than none.

**Cost.** Nothing slows bulk hold creation here. Named honestly rather than papered over.

### 20. Fan-facing copy is inline; translation is deferred

The strings a fan reads live in the components, with a small `t(web, mobile)` helper where the
surfaces differ. An earlier version routed them through a `copy.ts` and an `i18n.ts`; both are gone.
The indirection and plural-rules groundwork were more than an English-only prototype needs, and
following a reference into another file to read one sentence made the components harder to read.

**Cost.** A second language becomes a refactor rather than a content edit — taken deliberately, with
the path back noted in the README.

### 22. Giving up a hold is an explicit action, not an automatic swap

`cancel` moves an ACTIVE session to EXPIRED and returns its seats now rather than when the timer runs
out. The checkout page offers it as **Release these seats**, below Pay and visually quieter, and the
Server Action redirects to the listing, where the seats are already back and the quantity picker
offers the full range.

It exists because the per-browser dedup (entry 16) has a corollary: a browser that already holds seats
on a listing gets that hold back, so a fan who picked the wrong quantity had no way to change it
except to wait out the window. The alternative was to let `create` swap the hold when the quantity
differs. That needs an availability reader on the inventory interface so a swap that cannot fit
refuses *before* destroying the existing hold, and a listing page that adds the fan's own held seats
back into its picker — otherwise the fan holding every seat sees "these seats are gone" and no form at
all. The explicit release has neither problem: nothing is destroyed until the fan asks, and no path
can lose a hold to a swap that failed halfway.

Three details worth knowing. It ends at EXPIRED rather than a status of its own, so there is no new
state, no new screen, and `rehold` still works on the abandoned session. It takes no `version`: the
status check already refuses once a charge has started, which is the case that matters, and refusing a
release because the screen was stale would only stop a fan giving up seats they have decided against.
And it logs `hold_released_by_fan` rather than `hold_expired`, because the share of holds that lapse is
what the hold window is tuned against, and a deliberate release is not evidence the window is too short.

**Cost.** Two steps instead of one for a quantity change. `release` gained an optional event-name
parameter — a small widening of the one write path that ends a session.

### 21. What was deliberately not built

Auth, a database, a native app, a seat map, a cart, push infrastructure, SSE, a design system. Each
is either a separate project or a paragraph in the README's *With more time*. The goal was the
smallest thing that can be wrong in all the interesting ways, plus the tests that catch each way.
