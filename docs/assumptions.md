# Assumptions and non-goals

A take-home doesn't let you ask, so here are the questions I'd have asked and the answer I chose.
Each is a one-line change if the real answer differs.

| Question | Assumption |
|---|---|
| How long is a hold? Does it shrink near event start? | 10 min; 5 min inside the last hour; 2 min inside the last 15. Always capped at the sales cutoff. It's one policy function (`stubs.ts → policy.holdWindowMs`). |
| Does a price *decrease* need acceptance? | Yes. The invariant "the amount charged is a total the fan saw" is simpler than special-casing decreases. Product could relax it. |
| Can a hold be extended? | No. Longer holds help the holder and hurt everyone else. Documented as a policy knob. |
| Can the fan change quantity mid-session? | No. Quantity, listing and the hold deadline are fixed at creation, so a quantity change means a new session — release the hold and start again. (What does move on a session: status, the price on explicit acceptance, and bookkeeping — `version`, `lastSeenOn`, the idempotency record.) |
| Does completion need a payment webhook? | In production, yes. Here the stub is awaited, and **reconcile-on-read** stands in for the webhook: a `GET` on a pending session asks the provider. |
| Which surface is canonical for confirmation? | Neither. Any surface that reads a `COMPLETED` session shows the confirmation. |
| What if the listing is withdrawn mid-hold? | The session fails with its own reason. Seats are never silently swapped. |
| Is payment info portable across surfaces? | No. The session stores no payment details. Each surface collects payment fresh. |
| Who owns a session? | Out of scope. The link is bearer auth: anyone holding the URL can act on the session, and nothing checks that they are the fan who started it. Signed session tokens are the first thing to add — see the README's *With more time*. |
| Should one browser be able to hold a listing's whole inventory by repeating Buy → Start → Back? | No. An anonymous `cid` cookie identifies the browser, and `create` resumes its existing live hold per listing instead of taking new seats. |
| If a browser with a hold picks a new quantity and starts again, does the hold change? | No — it resumes the existing hold at its original quantity. To change quantity, press **Release these seats** on the checkout page and start again: the seats go back on sale immediately, so the listing page offers the full range. Having `create` swap the hold automatically ("latest quantity wins") was considered and deferred — see the README's *With more time* for why the explicit step is the safer default. |

## Non-goals

No real auth, no real payments, no database, no seat map, no cart, no native app.