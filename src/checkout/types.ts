/**
 * THE SHAPE OF A CHECKOUT SESSION
 *
 * Since src/checkout/service.ts is easier to follow once you know what it is moving around, read
 * this file first.
 *
 * The thing to notice is how `Session` is declared further down. Since a completed session must
 * always have an order ID and a failed one must always have a reason, and we would rather those
 * combinations be impossible to build than merely be things the tests go looking for, `Session`
 * is written as a list of alternatives instead of one object type with a pile of optional
 * fields: a session is *either* an active one, *or* a completed one, *or* a failed one, and each
 * alternative carries exactly the extra fields that make sense for it. There is no way to build
 * a completed session without an order ID, because that combination is not one of the choices.
 *
 * TypeScript calls this a discriminated union — `status` is the field that tells the alternatives
 * apart, and once you have checked it the compiler knows which extra fields exist. The practical
 * payoff is twofold: a whole category of bug becomes impossible to write, and any code branching
 * on status has to handle every case or it will not compile. The screen in
 * src/app/_components/RecoveryState.tsx relies on exactly that — add a sixth status and the build
 * breaks until someone decides what the fan should see.
 */

export type Surface = "web" | "mobile";

export type Status = "ACTIVE" | "PAYMENT_PENDING" | "COMPLETED" | "EXPIRED" | "FAILED";

export type FailReason = "DECLINED" | "PENDING_TIMEOUT" | "INVENTORY_WITHDRAWN";

/**
 * HOW A CHARGE TURNED OUT — three of these, not two, and the third is the important one.
 *
 *   ok        The money moved. Safe to finish the order.
 *   declined  The bank said no. Nothing moved, so it is safe to try another card.
 *   unknown   We do not know. The provider timed out, the connection dropped, we got a 500.
 *
 * Since the charge behind an `unknown` may well have succeeded, `unknown` is not an error state
 * to be cleaned up but an honest answer that has to be carried around, because treating it as a
 * failure and inviting the fan to try again is exactly how people get billed twice.
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
   * A counter that goes up by one every time this session changes.
   *
   * Since a fan may act on a screen that has since gone stale, this counter exists to catch that:
   * every response tells the client the version it is looking at, every request that wants to
   * change something has to send that number back, and if it no longer matches, the session moved
   * on since that screen was drawn, so the request is refused and the current session is returned
   * instead.
   *
   * This is a well-worn database pattern called optimistic concurrency, and it is used here rather
   * than locking for a specific reason: a fan may sit on the checkout page for ten minutes, and
   * locking the record for that long would be absurd, so instead everyone reads freely and
   * whichever write turns out to be based on an old copy is the one rejected.
   */
  version: number;
  createdOn: Surface;
  lastSeenOn: Surface;
  /**
   * The anonymous browser that created this checkout, if one identified itself.
   *
   * It comes from the `cid` cookie the server sets (see src/lib/client-id.ts). Its only job is
   * to let `create` recognise "this browser already has a live hold for this listing" and hand
   * that hold back rather than reserve a second set of seats — which is what stops one browser
   * from draining a listing by repeating Buy → Start → Back. It is optional because a caller
   * without the cookie (a raw API/curl request, an old test) simply gets no such dedup.
   *
   * This is a convenience for the honest, casual flow, not a security control: a client that
   * clears its cookie or talks to the API directly gets a fresh identity. The real limit on
   * bulk holds is a per-person cap behind real auth, noted in the README's "with more time".
   */
  clientId?: string;
  /**
   * A record of the payment attempts we have already seen, keyed by the value the browser sent.
   *
   * Since the browser generates one key per rendered checkout form, a form submitted twice — a
   * double-click, or the browser retrying after a dropped connection — carries the same key both
   * times, so this map lets the second copy be recognised as a repeat and handed the first one's
   * answer instead of starting another charge. ("Idempotent" just means doing something twice has
   * the same effect as doing it once.) See the long note above `complete` in service.ts for why
   * this and the status check are both needed and neither is enough on its own.
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
    // `unresolvedIntentId` is present only when a payment was in flight and we never got a
    // definite answer — that is, a PENDING_TIMEOUT failure. Since a charge could still have landed
    // after we gave up, this is the reference a later read uses to ask the provider again, so that
    // a late success is still noticed and refunded. A DECLINED failure does not carry it, because
    // a decline is a certain "no money moved".
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
 * HOW THE DOMAIN SAYS NO.
 *
 * Since we want any screen to be able to recover from any error without asking a second question,
 * every rejection needs to carry the session as it actually is and not just a code — the screen
 * then already has the truth and can simply redraw. The `code` exists only to pick the wording and
 * the button ("your hold ended, try again" versus "these tickets are gone, here are some others").
 * A rejection is turned into an HTTP response by src/lib/respond.ts, and into a screen by
 * src/app/_components/RecoveryState.tsx.
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
 * CHECK WHETHER SOMETHING IS ONE OF OUR REJECTIONS.
 *
 * The obvious way to write this is `err instanceof CheckoutError`, and that was the first version.
 * Since it worked in development and failed in production, it is worth knowing why: Next.js bundles
 * Server Actions and Route Handlers into separate chunks, each chunk ended up with its own copy of
 * the CheckoutError class, and `instanceof` compares identity — so an error thrown in one chunk and
 * caught in another was not "an instance of" the class the catching side knew about and sailed past
 * as an unexpected crash. This checks for a marker property instead, which works no matter how many
 * copies of the class exist.
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
 * EVERYTHING src/checkout/service.ts NEEDS FROM THE OUTSIDE WORLD, LISTED IN ONE PLACE.
 *
 * Since the service must be testable without a real clock, a real payment provider, or anything
 * else, it never imports those directly — it is handed this object and uses only what is on it.
 * The working implementations live in stubs.ts, and the tests build their own with a clock they
 * can fast-forward and a payment provider that fails on demand. That is why the whole test suite
 * runs in milliseconds with no server, no database and no mocking library: "what if the provider
 * times out eleven minutes from now" is a two-line setup rather than an integration test.
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
