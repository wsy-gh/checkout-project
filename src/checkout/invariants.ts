import type { Session, Status } from "./types";

/**
 * RULES THAT MUST BE TRUE OF EVERY SESSION, CHECKED ON EVERY WRITE
 *
 * An invariant is something that is true before a change and must still be true after it —
 * "a completed session always has an order ID", "a hold never outlasts the event". This file
 * collects them and `put` in src/checkout/service.ts runs them on every single write.
 *
 * The point is *when* a bug becomes visible. Without these, a mistake in the state machine
 * shows up much later as a strange screen or a wrong number, and you work backwards to find
 * it. With them, the write that broke the rule throws immediately, naming the session and
 * the rule. That is the difference between an afternoon of debugging and reading one line.
 *
 * They pay for themselves most in tests/invariants.test.ts, which throws hundreds of random
 * operations at the state machine and checks these after every one. Writing test assertions
 * for a random sequence is impossible — you do not know what should have happened — but
 * these rules hold no matter what happened, so they work as the assertion.
 */
export function assertInvariants(s: Session, now: number, salesCutoff: number): void {
  const must = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`Invariant violated on ${s.id} (${s.status}): ${msg}`);
  };

  // Terminal states are exclusive and carry what they need.
  if (s.status === "COMPLETED") must(s.orderId && s.paymentIntentId, "COMPLETED needs orderId + paymentIntentId");
  if (s.status !== "COMPLETED") must(!("orderId" in s), "only COMPLETED may carry orderId");
  if (s.status === "FAILED") must(s.failReason, "FAILED needs a reason");
  // Only a failed session may still be chasing a payment we could not resolve. Anywhere else
  // the field is a leak from a botched transition, which `strip` exists to prevent.
  if (s.status !== "FAILED") must(!("unresolvedIntentId" in s), "only FAILED may carry unresolvedIntentId");

  // PENDING always has something to reconcile against.
  if (s.status === "PAYMENT_PENDING") must(s.paymentIntentId && s.pendingSince > 0, "PENDING needs an intent");

  // A hold never outlives the event's sales cutoff.
  must(s.holdExpiresAt <= salesCutoff, "hold outlives sales cutoff");

  // Versions only go up.
  must(Number.isInteger(s.version) && s.version >= 0, "version must be a non-negative integer");

  // Never any payment details on the session.
  must(!("paymentToken" in s) && !("card" in s), "payment details on session");

  // `now` is accepted but deliberately not used to check that an ACTIVE session is still
  // within its deadline, which might look like the obvious rule to add here.
  //
  // It would be wrong. A session sitting past its deadline that nobody has read yet is
  // completely normal in this design — being expired is something that gets noticed on the
  // next read, not something that happens on a timer (see `get` in service.ts). Asserting it
  // on write would make a correct state illegal. The parameter stays because it costs
  // nothing and a future rule may want it.
  void now;
}

/**
 * Which status is allowed to follow which.
 *
 * Every status may stay where it is, because plenty of writes change other fields — a price
 * being accepted, an idempotency key being recorded — without moving the session on. The
 * three endings list only themselves, which is what makes them endings.
 */
const MAY_FOLLOW: Record<Status, readonly Status[]> = {
  ACTIVE: ["ACTIVE", "PAYMENT_PENDING", "EXPIRED", "FAILED"],
  PAYMENT_PENDING: ["PAYMENT_PENDING", "COMPLETED", "FAILED"],
  COMPLETED: ["COMPLETED"],
  EXPIRED: ["EXPIRED"],
  FAILED: ["FAILED"],
};

/**
 * Two rules about how a session may *change*, which the type system cannot express because
 * it only ever sees one session at a time and these compare before with after.
 *
 * FIRST: THE STATUS ONLY EVER MOVES FORWARD.
 *
 * This is quietly load-bearing. `settle` in service.ts decides whether it is safe to write
 * by asking "is this session still waiting on a payment?" — and that question only proves
 * anything if a session that has moved on can never move back. Today it cannot, but that is
 * a fact about the code rather than something the code insists on, and facts like that go
 * stale. If someone later adds a sensible-looking feature — say, letting a declined session
 * return to ACTIVE so the fan can try another card — that check silently stops protecting
 * anything and the double-release bug comes back with no test failing.
 *
 * So the rule is written down here and enforced, and that hypothetical change now announces
 * itself the moment it is made.
 *
 * SECOND: A WRITE MUST ADVANCE THE VERSION.
 *
 * This catches the general form of the bug above. A write assembled from a copy of the
 * session taken *before* an `await` carries whatever version was current back then. If
 * anything was written in the meantime, the stored version has already moved past it, and
 * this comparison notices. Verified to work: reintroducing the original bug now fails with
 * "Illegal write to cs_0001: FAILED -> COMPLETED" rather than silently inventing seats.
 */
export function assertTransition(prev: Session | undefined, next: Session): void {
  if (!prev) return;
  const bad = (msg: string) => {
    throw new Error(`Illegal write to ${next.id}: ${msg}`);
  };
  if (!MAY_FOLLOW[prev.status].includes(next.status)) bad(`${prev.status} -> ${next.status}`);
  if (next.version <= prev.version) bad(`version ${next.version} does not advance ${prev.version} (stale snapshot?)`);
}
