import type { Session } from "./types";

/**
 * Invariants the state machine must never break. Run after every write in the service
 * (cheap) and over random operation sequences in tests (where they earn their keep).
 */
export function assertInvariants(s: Session, now: number, salesCutoff: number): void {
  const must = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`Invariant violated on ${s.id} (${s.status}): ${msg}`);
  };

  // Terminal states are exclusive and carry what they need.
  if (s.status === "COMPLETED") must(s.orderId && s.paymentIntentId, "COMPLETED needs orderId + paymentIntentId");
  if (s.status !== "COMPLETED") must(!("orderId" in s), "only COMPLETED may carry orderId");
  if (s.status === "FAILED") must(s.failReason, "FAILED needs a reason");

  // PENDING always has something to reconcile against.
  if (s.status === "PAYMENT_PENDING") must(s.paymentIntentId && s.pendingSince > 0, "PENDING needs an intent");

  // A hold never outlives the event's sales cutoff.
  must(s.holdExpiresAt <= salesCutoff, "hold outlives sales cutoff");

  // Versions only go up.
  must(Number.isInteger(s.version) && s.version >= 0, "version must be a non-negative integer");

  // Never any payment details on the session.
  must(!("paymentToken" in s) && !("card" in s), "payment details on session");

  // `now` is here so a future check can assert ACTIVE sessions are unexpired after a read;
  // we deliberately don't assert it on write, because `get` is what turns expiry into EXPIRED.
  void now;
}
