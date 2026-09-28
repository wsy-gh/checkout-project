import { CheckoutError, HTTP_STATUS, isCheckoutError, type CheckoutError as CE, type Session } from "@/checkout/types";
import { checkout, stubs } from "@/lib/checkout";

/**
 * THE SHAPE OF EVERY REPLY FROM THE SESSION API, WHETHER IT WORKED OR NOT.
 *
 * Since a client that gets turned down should never have to make a second request to find out
 * where it now stands, every reply — success or failure — needs to carry the full session and
 * the server's clock reading, which is what this type guarantees. Failures add a `code` saying
 * which kind of "no" it was, so the client can pick the right wording without a follow-up call.
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
 * RUN A CHECKOUT OPERATION AND TRANSLATE WHATEVER HAPPENS INTO AN HTTP RESPONSE.
 *
 * Since the whole design keeps the rules in one place (src/checkout/service.ts) and wants the
 * route files to be trivial, this function needs to be the entirety of the API layer's logic:
 * the routes in src/app/api/sessions/ do nothing but read their arguments and hand them here.
 * It is implemented to sort outcomes into two kinds — an expected rejection (an expired hold, a
 * price change) becomes a 4xx that still carries the session, while anything else is a real bug
 * and is re-thrown — for the reason that a genuine crash should surface loudly rather than be
 * flattened into a polite error the client can't act on.
 *
 * Since a malformed body would otherwise crash the handler, the routes read their body *inside*
 * this callback rather than before calling it, so that body parsing sits under the same error
 * translation as everything else and a bad request becomes a 400 with a code. Before this was
 * done, a body of literal `null` crashed with
 * `TypeError: Cannot read properties of null (reading 'listingId')`.
 *
 * Since a checkout session is live state, `no-store` goes on every response, because a cached
 * copy of it becomes a lie the moment anything happens.
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
 * THE LARGEST REQUEST BODY ANY ROUTE HERE WILL READ.
 *
 * Since every endpoint in this API takes only a handful of short scalars — the biggest
 * legitimate body is a few hundred bytes — there is no size at which a larger body becomes
 * useful, and therefore no reason to read one. This cap exists because without it a 10MB body
 * was read in full and answered 201.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * READ A JSON OBJECT FROM A REQUEST, OR REJECT.
 *
 * Since a body that is absent and a body that cannot be understood both lead to the same place —
 * the domain finding its required values missing and rejecting with its own, better-worded
 * error — this returns `{}` in either case rather than trying to explain the problem itself.
 *
 * The one thing it is careful about is what counts as an object, and it is careful for a
 * specific reason: `JSON.parse` succeeds on `null`, on `[]`, and on `"a string"` — all valid
 * JSON, none of them a set of fields. `null` is the dangerous one, because it does not throw and
 * it is not an object, so a plain `try/catch` around the parse would let it through and the
 * first property access would crash. So the parse result is checked to be a non-array object,
 * and each of those non-object cases lands on `{}` instead. The size is also checked twice —
 * once from the declared `content-length` and once from the text actually read — because a
 * chunked request arrives with no content-length to declare.
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
