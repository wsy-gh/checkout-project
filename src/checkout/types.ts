/**
 * The shape of a checkout session. Worth reading before service.ts.
 *
 * `Session` is a discriminated union rather than one object type with optional fields: a session is
 * either active, or completed, or failed, and each alternative carries exactly the extra fields
 * that make sense for it. A completed session without an order ID is therefore not merely
 * discouraged but unbuildable, and any code branching on `status` must handle every case or fail
 * to compile — RecoveryState.tsx depends on that, so adding a sixth status breaks the build until
 * someone decides what the fan should see.
 */

export type Surface = "web" | "mobile";

export type Status = "ACTIVE" | "PAYMENT_PENDING" | "COMPLETED" | "EXPIRED" | "FAILED";

export type FailReason = "DECLINED" | "PENDING_TIMEOUT" | "INVENTORY_WITHDRAWN";

/**
 * How a charge turned out. Three outcomes, not two, and the third is the important one:
 *
 *   ok        Money moved. Safe to finish the order.
 *   declined  The bank said no. Nothing moved, so another card is safe to try.
 *   unknown   No answer — a timeout, a dropped connection, a 500.
 *
 * The charge behind an `unknown` may well have succeeded, so it is not an error state to clean up
 * but an answer to carry around: treating it as failure and inviting a retry is how people get
 * billed twice.
 */
export type PaymentOutcome = "ok" | "declined" | "unknown";

type Base = {
  id: string;
  listingId: string;
  quantity: number;
  /** Total in cents, fees included. Snapshot taken at creation; only changes via acceptPrice. */
  quotedTotal: number;
  priceVersion: number;
  /** Absolute server time (ms). Always <= the listing's sales cutoff. */
  holdExpiresAt: number;
  /**
   * Incremented on every change. Optimistic concurrency: every response reports the version the
   * client is looking at, every mutating request sends it back, and a mismatch means the session
   * moved on since that screen was drawn, so the request is refused and the current session
   * returned. Used instead of locking because a fan may sit on the checkout page for ten minutes.
   */
  version: number;
  createdOn: Surface;
  lastSeenOn: Surface;
  /**
   * The anonymous browser that created this checkout, from the `cid` cookie (see client-id.ts).
   * Its only job is to let `create` recognise "this browser already holds seats on this listing"
   * and return that hold rather than reserve more. Optional: a caller without the cookie (curl, an
   * older test) simply gets no dedup. A convenience for the honest flow, not a security control.
   */
  clientId?: string;
  /**
   * Payment attempts already seen, keyed by the value the browser sent. One key per rendered form,
   * so a form submitted twice carries the same key and the second copy is handed the first's answer
   * instead of starting another charge. See the note above `complete` for why this and the status
   * check are both needed.
   */
  idempotency: Record<string, PaymentOutcome>;
  createdAt: number;
};

export type Session = Base &
  (
    | { status: "ACTIVE" }
    | { status: "PAYMENT_PENDING"; paymentIntentId: string; pendingSince: number }
    | { status: "COMPLETED"; paymentIntentId: string; orderId: string }
    | { status: "EXPIRED"; successorSessionId?: string }
    // `unresolvedIntentId` appears only on a PENDING_TIMEOUT failure, where a charge was in flight
    // and never confirmed: it is the reference a later read uses to ask the provider again, so a
    // late success is still refunded. A DECLINED failure omits it, being a certain "no money moved".
    | { status: "FAILED"; failReason: FailReason; unresolvedIntentId?: string }
  );

export type SessionOf<S extends Status> = Extract<Session, { status: S }>;

export const TERMINAL: ReadonlySet<Status> = new Set(["COMPLETED", "EXPIRED", "FAILED"]);

export type ErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "PRICE_CHANGED"
  | "EXPIRED"
  | "IN_PROGRESS_ELSEWHERE"
  | "ALREADY_COMPLETED"
  | "ALREADY_FAILED"
  | "INVENTORY_WITHDRAWN"
  | "SOLD_OUT"
  | "SALES_CLOSED"
  | "PAYMENT_DECLINED";

export const HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  STALE_VERSION: 409,
  PRICE_CHANGED: 409,
  EXPIRED: 409,
  IN_PROGRESS_ELSEWHERE: 409,
  ALREADY_COMPLETED: 409,
  ALREADY_FAILED: 409,
  INVENTORY_WITHDRAWN: 409,
  SOLD_OUT: 409,
  SALES_CLOSED: 409,
  PAYMENT_DECLINED: 402,
};

export type PriceChange = { from: number; to: number; newPriceVersion: number };

/** A comparable listing, offered when the one behind a session is withdrawn. */
export type Alternative = { id: string; eventName: string; section: string; total: number };

/**
 * How the domain says no. Every rejection carries the session as it actually is, so any screen can
 * recover without a second request; `code` only picks the wording and the button.
 */
export class CheckoutError extends Error {
  readonly isCheckoutError = true as const;
  constructor(
    public readonly code: ErrorCode,
    public readonly session?: Session,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "CheckoutError";
  }
}

/**
 * Checks for a marker property rather than using `instanceof`, which worked in development and
 * failed in production: Next.js bundles Server Actions and Route Handlers into separate chunks,
 * each chunk got its own copy of the class, and `instanceof` compares identity — so an error
 * thrown in one chunk and caught in another sailed past as an unexpected crash.
 */
export function isCheckoutError(e: unknown): e is CheckoutError {
  return typeof e === "object" && e !== null && (e as { isCheckoutError?: unknown }).isCheckoutError === true;
}

export type CreateInput = { listingId: string; quantity: number; surface: Surface; clientId?: string };

export type AcceptPriceInput = { version: number; priceVersion: number; surface?: Surface };

export type CompleteInput = {
  version: number;
  priceVersion: number;
  idempotencyKey: string;
  paymentToken: string;
  surface?: Surface;
};

/**
 * Everything the service needs from the outside world. It never imports these directly, so tests
 * supply a clock they can fast-forward and a payment provider that fails on demand — which is why
 * the suite runs in milliseconds with no server and no mocking library, and why "the provider times
 * out eleven minutes from now" is a two-line setup rather than an integration test.
 */
export interface Deps {
  clock: { now(): number };
  ids: { next(prefix: string): string };
  pricing: { current(listingId: string): { total: number; version: number } };
  inventory: {
    /** Atomically take `qty` units if available. */
    hold(listingId: string, qty: number): boolean;
    release(listingId: string, qty: number): void;
    /** False once a seller delists / the primary voids the listing. */
    backs(listingId: string): boolean;
    salesCutoff(listingId: string): number;
    /** What to offer a fan whose listing went away. */
    alternatives(listingId: string): Alternative[];
  };
  payments: {
    /** `token` is what provider-hosted fields hand back; the stub ignores it. */
    charge(intentId: string, token?: string): Promise<PaymentOutcome>;
    status(intentId: string): Promise<PaymentOutcome>;
    /** Refund a charge we later discover landed on a session we had already written off. */
    refund(intentId: string): void;
  };
  events: { emit(name: string, data: Record<string, unknown>): void };
  /** The return path: what brings a fan back before the hold lapses. */
  notifier: { holdExpiringSoon(sessionId: string): void };
  policy: {
    /** How long a hold lasts, as a function of how much selling time is left. */
    holdWindowMs(msUntilCutoff: number): number;
    pendingTimeoutMs: number;
    /** How far ahead of holdExpiresAt the "expiring soon" notice goes out. */
    notifyLeadMs: number;
  };
}
