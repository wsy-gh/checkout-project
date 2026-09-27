import { CheckoutError, HTTP_STATUS, isCheckoutError, type CheckoutError as CE, type Session } from "@/checkout/types";
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
  code?: CE["code"];
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
 * Note that the routes read their body *inside* this callback rather than before calling it.
 * That is deliberate: it puts body parsing under the same error translation as everything
 * else, so a malformed request gets a 400 with a code instead of escaping as a 500. Before
 * this, a body of literal `null` crashed with
 * `TypeError: Cannot read properties of null (reading 'listingId')`.
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

/**
 * The largest request body any route here will read.
 *
 * Every endpoint in this API takes a handful of short scalars; the biggest legitimate body is
 * a few hundred bytes. There is no size at which a larger one becomes useful, so there is no
 * reason to read it. Without this, a 10MB body was parsed in full and answered 201.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * Read a JSON object from a request, or reject.
 *
 * Returns `{}` for a body that is absent or unreadable, because "no fields" and "fields I
 * could not understand" lead to the same place: the domain finds its required values missing
 * and rejects with its own error, which is a better message than anything this layer could
 * invent.
 *
 * The thing it is careful about is what counts as an object. `JSON.parse` succeeds on
 * `null`, on `[]` and on `"a string"` — all valid JSON, none of them a set of fields. `null`
 * in particular is the interesting one, because it does not throw and it is not an object, so
 * a `try/catch` around the parse lets it through and the first property access crashes. Each
 * of those now lands on `{}`.
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
  // Checked again after reading: a chunked request arrives with no content-length to declare.
  if (text.length > MAX_BODY_BYTES) throw new CheckoutError("INVALID_REQUEST");
  if (text.trim() === "") return {} as T;

  try {
    const parsed: unknown = JSON.parse(text);
    return (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as T;
  } catch {
    return {} as T;
  }
}
