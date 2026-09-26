/**
 * Domain types for a checkout session.
 *
 * Design rule: illegal states are unrepresentable. A COMPLETED session cannot exist
 * without an orderId; a FAILED one cannot exist without a reason. The discriminated
 * union enforces this at compile time so tests only need to cover transitions.
 */

export type Surface = "web" | "mobile";

export type Status = "ACTIVE" | "PAYMENT_PENDING" | "COMPLETED" | "EXPIRED" | "FAILED";

export type FailReason = "DECLINED" | "PENDING_TIMEOUT" | "INVENTORY_WITHDRAWN";

/** What the payment provider told us. `unknown` is a real outcome, not an error. */
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
  /** Bumps on every mutation. Clients send back the version they last saw. */
  version: number;
  createdOn: Surface;
  lastSeenOn: Surface;
  /** Replay table: idempotencyKey -> outcome of the completed attempt. */
  idempotency: Record<string, PaymentOutcome>;
  createdAt: number;
};

export type Session = Base &
  (
    | { status: "ACTIVE" }
    | { status: "PAYMENT_PENDING"; paymentIntentId: string; pendingSince: number }
    | { status: "COMPLETED"; paymentIntentId: string; orderId: string }
    | { status: "EXPIRED"; successorSessionId?: string }
    | { status: "FAILED"; failReason: FailReason }
  );

export type SessionOf<S extends Status> = Extract<Session, { status: S }>;

export const TERMINAL: ReadonlySet<Status> = new Set(["COMPLETED", "EXPIRED", "FAILED"]);

export type ErrorCode =
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "PRICE_CHANGED"
  | "EXPIRED"
  | "IN_PROGRESS_ELSEWHERE"
  | "ALREADY_COMPLETED"
  | "ALREADY_FAILED"
  | "INVENTORY_WITHDRAWN"
  | "SOLD_OUT"
  | "PAYMENT_DECLINED";

export const HTTP_STATUS: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  STALE_VERSION: 409,
  PRICE_CHANGED: 409,
  EXPIRED: 409,
  IN_PROGRESS_ELSEWHERE: 409,
  ALREADY_COMPLETED: 409,
  ALREADY_FAILED: 409,
  INVENTORY_WITHDRAWN: 409,
  SOLD_OUT: 409,
  PAYMENT_DECLINED: 402,
};

export type PriceChange = { from: number; to: number; newPriceVersion: number };

/**
 * Every rejection carries the current session so a client can always recover by
 * rendering `session`. `code` only picks the copy and the primary action.
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
 * Identify a CheckoutError by its brand, not by `instanceof`. The domain, the Route
 * Handlers and the Server Actions can be bundled into separate chunks, each with its
 * own copy of the class — `instanceof` is then false across that boundary in production.
 */
export function isCheckoutError(e: unknown): e is CheckoutError {
  return typeof e === "object" && e !== null && (e as { isCheckoutError?: unknown }).isCheckoutError === true;
}

export type CreateInput = { listingId: string; quantity: number; surface: Surface };

export type AcceptPriceInput = { version: number; priceVersion: number; surface?: Surface };

export type CompleteInput = {
  version: number;
  priceVersion: number;
  idempotencyKey: string;
  paymentToken: string;
  surface?: Surface;
};

/** Everything the domain needs from the outside world, so tests can stub all of it. */
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
  };
  payments: {
    /** `token` is what provider-hosted fields hand back; the stub ignores it. */
    charge(intentId: string, token?: string): Promise<PaymentOutcome>;
    status(intentId: string): Promise<PaymentOutcome>;
  };
  events: { emit(name: string, data: Record<string, unknown>): void };
  policy: {
    /** How long a hold lasts, as a function of time to event. */
    holdWindowMs(msUntilEvent: number): number;
    pendingTimeoutMs: number;
  };
}
