import type { Session, Status } from "./types";

/**
 * RULES THAT MUST BE TRUE OF EVERY SESSION, CHECKED ON EVERY WRITE
 *
 * An invariant is something that is true before a change and must still be true after it — for
 * example, "a completed session always has an order ID" or "a hold never outlasts the event".
 * Since a mistake in the state machine that produced an impossible session would otherwise show
 * up much later as a strange screen or a wrong number, forcing you to work backwards to find it,
 * this file collects those rules and `put` in src/checkout/service.ts runs them on every single
 * write — so the write that breaks a rule throws immediately, naming the session and the rule.
 * That is the difference between an afternoon of debugging and reading one line.
 *
 * These rules pay for themselves most in tests/invariants.test.ts, which throws hundreds of
 * random operations at the state machine and checks them after every one. Writing ordinary
 * assertions for a random sequence is impossible — you do not know what should have happened —
 * but these hold no matter what happened, so they serve as the assertion.
 */
export function assertInvariants(s: Session, now: number, salesCutoff: number): void {
  const must = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`Invariant violated on ${s.id} (${s.status}): ${msg}`);
  };

  // Since each terminal state owns particular extra fields, these checks confirm that a session
  // in a given status carries exactly what that status needs and nothing that belongs to another.
  if (s.status === "COMPLETED") must(s.orderId && s.paymentIntentId, "COMPLETED needs orderId + paymentIntentId");
  if (s.status !== "COMPLETED") must(!("orderId" in s), "only COMPLETED may carry orderId");
  if (s.status === "FAILED") must(s.failReason, "FAILED needs a reason");
  // Since only a failed session should still be chasing a payment we could not resolve, the
  // reference must not appear anywhere else; if it does, it is a leak from a botched transition,
  // which `strip` in service.ts exists to prevent, and this catches the leak at the write.
  if (s.status !== "FAILED") must(!("unresolvedIntentId" in s), "only FAILED may carry unresolvedIntentId");

  // Since a pending session is defined by having a charge to reconcile against, it must carry the
  // intent that reconciliation will ask about.
  if (s.status === "PAYMENT_PENDING") must(s.paymentIntentId && s.pendingSince > 0, "PENDING needs an intent");

  // A hold must never outlive the event's sales cutoff.
  must(s.holdExpiresAt <= salesCutoff, "hold outlives sales cutoff");

  // The version counter must only ever be a non-negative integer.
  must(Number.isInteger(s.version) && s.version >= 0, "version must be a non-negative integer");

  // No payment details may ever be stored on the session.
  must(!("paymentToken" in s) && !("card" in s), "payment details on session");

  // `now` is accepted but deliberately not used to assert that an ACTIVE session is still within
  // its deadline, which might look like the obvious rule to add here. Since being expired is
  // something noticed on the next read rather than something that happens on a timer (see `get`
  // in service.ts), a session sitting past its deadline that nobody has read yet is a completely
  // normal state in this design, so asserting the deadline on write would make a correct state
  // illegal. The parameter stays because it costs nothing and a future rule may want it.
  void now;
}

/**
 * WHICH STATUS IS ALLOWED TO FOLLOW WHICH.
 *
 * Every status lists itself, because plenty of writes change other fields — a price being
 * accepted, an idempotency key being recorded — without moving the session to a new status. The
 * three ending states list only themselves, which is exactly what makes them endings.
 */
const MAY_FOLLOW: Record<Status, readonly Status[]> = {
  ACTIVE: ["ACTIVE", "PAYMENT_PENDING", "EXPIRED", "FAILED"],
  PAYMENT_PENDING: ["PAYMENT_PENDING", "COMPLETED", "FAILED"],
  COMPLETED: ["COMPLETED"],
  EXPIRED: ["EXPIRED"],
  FAILED: ["FAILED"],
};

/**
 * TWO RULES ABOUT HOW A SESSION MAY *CHANGE*.
 *
 * Since the type system only ever sees one session at a time, it cannot express rules that
 * compare the before with the after, so those two rules are enforced here instead.
 *
 * FIRST: THE STATUS ONLY EVER MOVES FORWARD.
 *
 * This is quietly load-bearing. `settle` in service.ts decides whether a write is safe by asking
 * "is this session still waiting on a payment?", and that question only proves anything if a
 * session that has moved on can never move back. Today it cannot — but that is a fact about the
 * current code rather than something the code insists on, and facts like that go stale. If
 * someone later added a sensible-looking feature, say letting a declined session return to ACTIVE
 * so the fan can try another card, that check would silently stop protecting anything and the
 * double-release bug would return with no test failing. So the rule is written down and enforced
 * here, and that hypothetical change now announces itself the moment it is made.
 *
 * SECOND: A WRITE MUST ADVANCE THE VERSION.
 *
 * This catches the general form of the same bug. A write assembled from a copy of the session
 * taken *before* an `await` carries whatever version was current back then; if anything was
 * written in the meantime, the stored version has already moved past it, and this comparison
 * notices. It is verified to work: reintroducing the original bug now fails with
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
