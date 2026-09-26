# Decisions

Short ADR-style entries. Each: what was decided, why, what it costs, and where the idea comes from.

---

## 1. The hold and the inventory live in the same store, mutated together

**Decision.** A session *is* the hold. `create` takes units from inventory and writes the session in one synchronous function; `release` gives them back and writes the terminal state in one synchronous function.

**Why.** If holds live in one store (say Redis, with a TTL) and inventory in another (say MySQL), no single transaction can update both. A crash between the two writes leaves them disagreeing: either stock is hidden that is actually available, or stock is sold that is already gone. Changing the write order only changes which failure you get.

**Cost.** In production this means the hold table sits next to the ledger and takes the write load. Shopify's answer was one row per reservable unit and `SELECT … FOR UPDATE SKIP LOCKED` so concurrent buyers lock different rows; for tickets that's free, since a seat already is one row.

**Source.** Shopify Engineering, *Scaling inventory reservations* (May 2026) — the move from Redis counters to MySQL rows, and why the two-store split had to go. Retold at hellointerview.com/learn/system-design/in-the-wild/shopify-inventory-reservations.

---

## 2. Expiry is a predicate on ACTIVE, and PAYMENT_PENDING is exempt from it

**Decision.** "Valid" = `ACTIVE && now < holdExpiresAt && listing still backs it`, evaluated on every read. Nothing fires when the deadline passes. A session in `PAYMENT_PENDING` is never expired by the clock; it resolves by payment outcome or by a pending timeout that consults the provider.

**Why.** A timer-based release can free a seat while the first fan's card is mid-charge — a double sell. Making the deadline a property of the row and exempting the in-flight state removes both the race and the need for a correctness-critical background job. A sweeper becomes garbage collection.

**Cost.** PENDING can hold a seat past the window while a provider is slow. The pending timeout bounds it.

**Source.** The "implicit status via expiration time" option in Hello Interview's Ticketmaster breakdown, which is also where Shopify's design converged (`expires_at` on the hold; availability filtered by it).

---

## 3. Two dedupe mechanisms, two jobs: status CAS and idempotency key

**Decision.** *Different devices* are deduplicated by a compare-and-set on status: re-read the row synchronously, check `ACTIVE` and the expected `version`, flip to `PAYMENT_PENDING`, no `await` in between. *The same device's retry* is deduplicated by a client-carried idempotency key stored on the session with its outcome and replayed.

**Why.** A key cannot stop two devices — they hold different keys. A CAS cannot help a retry — the retry arrives after the first attempt already flipped status and would be told "in progress elsewhere" about its own request. Each mechanism covers exactly the case the other cannot.

**Cost.** The key must be minted once per attempt and reused on retry. Here it's minted on the server per page render and carried as a hidden input, so a resubmit of the rendered form replays. A client-side fetch would mint it in state.

**Source.** Airbnb Engineering, *Avoiding double payments in a distributed payments system* (Jon Chew): client passes a unique key per request and reuses it on retries; server locks on the key before processing. Stripe, *Designing robust and predictable APIs with idempotency* (Brandur Leach): retries plus idempotency keys, with backoff and jitter.

---

## 4. Payment is three-phase, with the intent written before the call

**Decision.** `complete` (a) flips to `PAYMENT_PENDING` and writes `paymentIntentId` (= session ID, used as the provider's idempotency key), (b) calls the provider, (c) records the outcome. A `GET` on a `PAYMENT_PENDING` session asks the provider for the intent's status and reconciles.

**Why.** If the server dies between (b) and (c), the fan was charged and the session is stuck. Because the intent was recorded in (a), the next read can ask "what happened to intent X?" and land on `COMPLETED` or `FAILED` instead of leaving a dead end. In production this is the webhook plus a reconciliation job; reconcile-on-read has the same shape.

**Cost.** `get` is async, which is why every mutation re-reads the row after awaiting it (see decision 3).

**Source.** Airbnb's pre-RPC / RPC / post-RPC split in the same post: validate and lock before the external call, make the call, record after.

---

## 5. Three payment outcomes: ok, declined, unknown

**Decision.** The provider stub returns `ok | declined | unknown`. `declined` fails the session and releases the hold; `unknown` keeps it `PAYMENT_PENDING` and the UI says "we're confirming — don't retry."

**Why.** A timeout is not a decline. The idempotency key protects the *same* request, but a fan told "payment failed, try again" re-enters a card and creates a *new* request. That is the double charge the whole design exists to prevent. Only `declined` unlocks retry.

**Cost.** One more enum value, one more recovery view, and a pending timeout so unknown can't hang forever.

---

## 6. SSR the session; hydrate only what ticks; Pay is a real form

**Decision.** The checkout page is a Server Component. Session, total, and a countdown seeded from `serverNow` are in the HTML. The countdown ticks in an effect using a skew computed once from the server clock. Pay is a `<form>` posting to a Server Action, so it works before hydration and without JavaScript.

**Why.** The fan is under time pressure; the first paint must be actionable and the number must be right regardless of the device clock. Rendering the tick during the initial render would cause a hydration mismatch (server says 9:58, client says 9:55); seeding both from the same two numbers avoids it.

**Cost.** Server Actions and Route Handlers are two transports over one domain — two ~6-line adapters for `complete`. Also, they are bundled into separate chunks in production, so `instanceof CheckoutError` is false across that boundary; errors are identified by a brand property instead. This was found by the production build, not by dev.

**Source.** Airbnb Engineering, *Operationalizing Node.js for Server Side Rendering* (Hypernova; embed props and client-render on SSR failure) and *Server Rendering, Code Splitting, and Lazy Loading with React Router v4* (match the route before rendering or get a client/server mismatch). Next.js docs on Server Actions: forms that call them submit before hydration.

---

## 7. Price is a snapshot of the total, changed only by explicit accept

**Decision.** `quotedTotal` and `priceVersion` are frozen at creation. `GET` reports a `priceChange` if the live total differs; `complete` refuses unless the body's `priceVersion` matches the session *and* the session's matches the live price. `accept-price` is the only way to move the snapshot. Decreases require acceptance too.

**Why.** The invariant "the amount charged is a total the fan saw" is simple to state, test, and explain. Checking only the client's `priceVersion` leaves a window where the price moves after the last GET; the second comparison closes it.

**Cost.** A price decrease makes the fan click once more. Product could auto-apply decreases; the rule is a one-line change.

---

## 8. A read from another surface does not bump `version`

**Decision.** `lastSeenOn` is updated on resume without bumping `version`. Only substantive changes (price accepted, status changed) bump it.

**Why.** Version is the CAS counter. If a mere `GET` from the phone invalidated the laptop's version, a fan who glanced at the app would have their web Pay rejected for no reason. Telemetry must not masquerade as state.

**Cost.** None; this fell out of the tests (a cross-surface resume followed by a complete was failing with `STALE_VERSION`).

---

## 9. Reset singletons in place; never swap them

**Decision.** The in-memory service and stubs live on `globalThis` and expose `reset()` methods that rebuild their state. `resetAll()` never assigns new instances.

**Why.** Route Handlers and Server Components are separate module graphs in the dev server. A module that imported `checkout` before a reset kept the old instance while newly compiled modules got the new one — sessions created by the API were "not found" by the page.

**Cost.** Stubs keep their mutable state behind one object so `seed()` can rebuild it. Slightly more code than `let x = new …`.

---

## 10. What was deliberately not built

Auth, a database, a native app, a seat map, a cart, push infrastructure, SSE, a design system. Each is either a separate project or a paragraph in the README's *With more time*. The goal was the smallest thing that can be wrong in all the interesting ways, plus the tests that catch each way.
