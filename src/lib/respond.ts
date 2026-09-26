import { HTTP_STATUS, isCheckoutError, type CheckoutError, type Session } from "@/checkout/types";
import { checkout, stubs } from "@/lib/checkout";

/**
 * The shape of every reply from the session API, whether it worked or not.
 *
 * Both cases carry the full session, so a client never has to ask a follow-up question to
 * find out where it stands. Failures add a `code` saying which kind of no it was.
 */
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
 * Run a checkout operation and translate whatever happens into an HTTP response.
 *
 * This is the whole of the API layer's logic, which is the point — the route files in
 * src/app/api/sessions/ do nothing but read their arguments and hand them to
 * src/checkout/service.ts. Expected rejections (an expired hold, a price change) become a
 * 4xx carrying the session. Anything else is a real bug and is re-thrown so it surfaces
 * rather than being flattened into a polite error.
 *
 * `no-store` goes on every response because a checkout session is live state, and a cached
 * copy of it is a lie the moment anything happens.
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
