import { HTTP_STATUS, isCheckoutError, type CheckoutError, type Session } from "@/checkout/types";
import { checkout, stubs } from "@/lib/checkout";

/** Every session response, success or failure, has this shape. Clients render `session`. */
export type SessionResponse = {
  session: Session;
  serverNow: number;
  priceChange?: { from: number; to: number; newPriceVersion: number };
  code?: CheckoutError["code"];
  [k: string]: unknown;
};

const NO_STORE = { "Cache-Control": "no-store" };

export function envelope(session: Session): SessionResponse {
  return { session, serverNow: stubs.clock.now(), priceChange: checkout.priceChange(session) };
}

/**
 * Run a domain call and map the outcome to HTTP. A CheckoutError becomes
 * `{ code, session, ...extra }` with the matching status; anything else is a 500.
 */
export async function respond(fn: () => Promise<Session> | Session): Promise<Response> {
  try {
    return Response.json(envelope(await fn()), { headers: NO_STORE });
  } catch (e) {
    if (isCheckoutError(e)) {
      const body = { code: e.code, serverNow: stubs.clock.now(), ...(e.session ? envelope(e.session) : {}), ...e.extra };
      return Response.json(body, { status: HTTP_STATUS[e.code], headers: NO_STORE });
    }
    throw e;
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}
