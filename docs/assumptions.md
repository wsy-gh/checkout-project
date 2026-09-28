# Assumptions and non-goals

A take-home doesn't let you ask, so here are the questions I'd have asked and the answer I chose.
Each is a one-line change if the real answer differs.

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
| Should one browser be able to hold a listing's whole inventory by repeating Buy → Start → Back? | No. An anonymous `cid` cookie identifies the browser, and `create` resumes its existing live hold per listing instead of taking new seats. Scoped per (browser, listing), so buying two different events still works. |
| If a browser with a hold picks a new quantity and starts again, does the hold change? | No — it resumes the existing hold at its original quantity. Changing quantity means letting the hold lapse (there is no cancel button in the prototype). A one-line change if product wants "latest quantity wins". |

## Non-goals

No real auth, no real payments, no database, no seat map, no cart, no native app, no push
infrastructure. Each would add a day and no continuity signal. The migration path for the ones
that matter is in the README's *With more time*.
