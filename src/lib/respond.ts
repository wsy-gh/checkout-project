import { CheckoutError, HTTP_STATUS, isCheckoutError, type CheckoutError as CE, type Session } from "@/checkout/types";
import { checkout, stubs } from "@/lib/checkout";

/**
 * Every reply from the session API, success or failure, carries the full session and the server's
 * clock reading, so a client that is turned down never needs a second request to learn where it
 * stands. Failures add a `code` saying which kind of "no" it was.
 */
export type SessionResponse = {
  session: Session;
  serverNow: number;
  priceChange?: { from: number; to: number; newPriceVersion: number };
  code?: CE["code"];
  [k: string]: unknown;
};

const NO_STORE = { "Cache-Control": "no-store" };

export function envelope(session: Session): SessionResponse {
  return { session, serverNow: stubs.clock.now(), priceChange: checkout.priceChange(session) };
}

/**
 * Runs a checkout operation and translates the outcome into HTTP — the whole of the API layer's
 * logic, so the route files only read their arguments and hand them here.
 *
 * Expected rejections (an expired hold, a price change) become a 4xx that still carries the
 * session; anything else is re-thrown, so a genuine bug surfaces loudly instead of being
 * flattened into a polite error the client cannot act on.
 *
 * Routes read their body *inside* this callback rather than before calling it, so body parsing
 * sits under the same translation and a malformed body becomes a 400 rather than a crash — a body
 * of literal `null` used to fail with "Cannot read properties of null".
 *
 * `no-store` on every response: a cached copy of live session state becomes a lie immediately.
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

// Every endpoint takes a handful of short scalars, so no larger body is ever useful. Without this
// cap a 10MB body was read in full and answered 201.
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Read a JSON object from a request, or reject.
 *
 * An absent body and an unparseable one both return `{}`, because both end in the same place: the
 * domain finding required values missing and rejecting with a better-worded error.
 *
 * What counts as an object matters, though. `JSON.parse` succeeds on `null`, `[]` and `"a string"`
 * — all valid JSON, none a set of fields — and `null` is the dangerous one, since it neither
 * throws nor is an object, so a plain try/catch lets it through and the first property access
 * crashes. Size is checked twice, from `content-length` and from the text actually read, because a
 * chunked request declares no length.
 */
export async function readJson<T>(req: Request): Promise<T> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new CheckoutError("INVALID_REQUEST");

  let text: string;
  try {
    text = await req.text();
  } catch {
    return {} as T;
  }
  if (text.length > MAX_BODY_BYTES) throw new CheckoutError("INVALID_REQUEST");
  if (text.trim() === "") return {} as T;

  try {
    const parsed: unknown = JSON.parse(text);
    return (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}
