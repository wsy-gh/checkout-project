import type { Session, Status } from "./types";

/**
 * Rules that must hold for every session, checked by `put` on every write. An impossible session
 * would otherwise surface much later as a strange screen or a wrong count, leaving you to work
 * backwards; here the offending write throws immediately, naming the session and the rule.
 *
 * They also serve as the assertion in tests/invariants.test.ts, which throws hundreds of random
 * operations at the state machine: ordinary assertions are impossible for a random sequence
 * because you do not know what should have happened, but these hold regardless.
 */
export function assertInvariants(s: Session, now: number, salesCutoff: number): void {
  const must = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`Invariant violated on ${s.id} (${s.status}): ${msg}`);
  };

  // Each status must carry exactly its own extra fields and none belonging to another status.
  if (s.status === "COMPLETED") must(s.orderId && s.paymentIntentId, "COMPLETED needs orderId + paymentIntentId");
  if (s.status !== "COMPLETED") must(!("orderId" in s), "only COMPLETED may carry orderId");
  if (s.status === "FAILED") must(s.failReason, "FAILED needs a reason");
  // An unresolved intent anywhere but FAILED is a leak from a botched transition — the thing
  // `strip` exists to prevent — and this catches it at the write.
  if (s.status !== "FAILED") must(!("unresolvedIntentId" in s), "only FAILED may carry unresolvedIntentId");

  if (s.status === "PAYMENT_PENDING") must(s.paymentIntentId && s.pendingSince > 0, "PENDING needs an intent");

  must(s.holdExpiresAt <= salesCutoff, "hold outlives sales cutoff");
  must(Number.isInteger(s.version) && s.version >= 0, "version must be a non-negative integer");
  must(!("paymentToken" in s) && !("card" in s), "payment details on session");

  // `now` is deliberately not used to assert that an ACTIVE session is still inside its deadline,
  // which looks like the obvious rule to add. Expiry is noticed on the next read rather than on a
  // timer, so a session sitting past its deadline that nobody has read is a normal state here, and
  // asserting it on write would make a correct state illegal.
  void now;
}

/**
 * Which status may follow which. Every status lists itself, because many writes change other
 * fields without moving status. The endings list only themselves, which is what makes them endings.
 */
const MAY_FOLLOW: Record<Status, readonly Status[]> = {
  ACTIVE: ["ACTIVE", "PAYMENT_PENDING", "EXPIRED", "FAILED"],
  PAYMENT_PENDING: ["PAYMENT_PENDING", "COMPLETED", "FAILED"],
  COMPLETED: ["COMPLETED"],
  EXPIRED: ["EXPIRED"],
  FAILED: ["FAILED"],
};

/**
 * The two rules that compare a session before a write with the session after it — which the type
 * system cannot express, since it only ever sees one session at a time.
 *
 * Status only moves forward. This is load-bearing: `settle` decides a write is safe by asking "is
 * this still PAYMENT_PENDING?", which only proves anything if a session that moved on can never
 * move back. That is true of today's code but is not something today's code insists on, so a later
 * feature — letting a declined session return to ACTIVE to try another card, say — would silently
 * stop that check from protecting anything. Enforced here, such a change announces itself.
 *
 * A write must advance the version. This catches the general form of the same bug: a write
 * assembled from a copy taken before an `await` carries the version from back then, and if
 * anything was written meanwhile, the stored version has already moved past it.
 */
export function assertTransition(prev: Session | undefined, next: Session): void {
  if (!prev) return;
  const bad = (msg: string) => {
    throw new Error(`Illegal write to ${next.id}: ${msg}`);
  };
  if (!MAY_FOLLOW[prev.status].includes(next.status)) bad(`${prev.status} -> ${next.status}`);
  if (next.version <= prev.version) bad(`version ${next.version} does not advance ${prev.version} (stale snapshot?)`);
}
