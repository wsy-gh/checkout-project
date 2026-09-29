import { cookies } from "next/headers";
import { v7 as uuidv7 } from "uuid";

/**
 * The anonymous browser identity: a random id in a `cid` cookie, read or minted only here. It
 * lets the server recognise the same browser without a login, which is what stops one browser
 * reserving a fresh set of seats each time it repeats Buy → Start → Back (see `create`).
 *
 * A cookie rather than localStorage or a fingerprint: it is sent automatically with every request,
 * including the Server Action POST behind the Buy form, and it survives the Back navigation that
 * is the flow being fixed — localStorage is neither sent to the server nor reachable from a Server
 * Action. `httpOnly`, since the client never needs to read this and should not be able to forge it
 * from script. A device fingerprint was rejected deliberately: it drifts as browsers update, and
 * it is a privacy-hostile way to track people, where a random opaque id carries no information.
 *
 * Not a security boundary. Clearing the cookie, or calling the API without one, yields a fresh
 * identity, so this bounds the accidental flow only; the real limit on bulk holds is a per-person
 * cap behind real auth.
 */

const COOKIE = "cid";

// A year — the identity is disposable, so this only has to outlast a returning fan.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Read the browser's identity, minting and setting one if it has none.
 *
 * Cookies may only be set from a Server Action or Route Handler, not during a Server Component
 * render, so this must be called from one of those — `createSession` is its caller. Setting a
 * cookie then redirecting is fine: the `Set-Cookie` rides out on the redirect response.
 */
export async function getOrCreateClientId(): Promise<string> {
  const store = await cookies();
  const existing = store.get(COOKIE)?.value;
  if (existing) return existing;

  const id = uuidv7();
  store.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
    // Only require HTTPS in production, so the cookie still works on http://localhost in dev.
    secure: process.env.NODE_ENV === "production",
  });
  return id;
}

/**
 * Read the identity without ever setting one, for read-only server contexts like the home page.
 * A browser that has started nothing has no `cid` and gets undefined, which is correct: it has no
 * holds of its own to resume.
 */
export async function readClientId(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE)?.value;
}

/**
 * Pull the `cid` from a raw Cookie header instead of using `next/headers`. The JSON API uses this
 * because it never needs to *set* the cookie, and because reading the header directly keeps the
 * route callable as a plain function in tests, where `next/headers` has no request scope. A
 * browser calling the API with a `cid` still gets dedup; a cookie-less curl gets undefined.
 */
export function clientIdFromRequest(req: Request): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE && rest.length) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}
