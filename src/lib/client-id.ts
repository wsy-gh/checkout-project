import { cookies } from "next/headers";
import { v7 as uuidv7 } from "uuid";

/**
 * THE ANONYMOUS BROWSER IDENTITY
 *
 * Since one browser repeating Buy → Start → Back can otherwise reserve a fresh set of seats each
 * time (see the dedup note in src/checkout/service.ts's `create`), the server needs a way to
 * recognise "this is the same browser again" without any login. That identity is a random id kept
 * in a cookie named `cid`, and this file is the one place it is read or minted.
 *
 * WHY A COOKIE, RATHER THAN localStorage OR A FINGERPRINT
 *
 * A cookie is the only option that actually fits the job. It is sent automatically with every
 * request — including the Server Action POST behind the Buy form and the JSON API — and it survives
 * the Back navigation, which is the exact flow being fixed; localStorage is neither sent to the
 * server nor available in a Server Action without the client plumbing it through by hand. It is set
 * by the server as `httpOnly`, so page JavaScript cannot read or alter it, which is right for an
 * identity the client never needs to see and should not be able to forge from script. A computed
 * device fingerprint was rejected on purpose: it is unreliable (it drifts as the browser updates)
 * and it is a privacy-hostile way to track people, whereas a random opaque id carries no
 * information about anyone.
 *
 * WHAT THIS IS NOT
 *
 * It is not a security boundary. A determined client clears the cookie or talks to the API without
 * one and gets a fresh identity, so this only bounds the honest, accidental flow. The real limit on
 * bulk holds is a per-person cap behind real auth, which the README lists under "with more time".
 */

const COOKIE = "cid";

// A year. The identity is disposable, so the exact lifetime barely matters; long enough that a
// returning fan is still recognised is all it needs to be.
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Read the caller's browser identity, minting and setting one if this browser has none yet.
 *
 * Since setting a cookie is only allowed from a Server Action or a Route Handler (not during a
 * Server Component render), this must be called from one of those — the `createSession` Server
 * Action is its caller. Setting the cookie and then redirecting is fine: the `Set-Cookie` rides
 * out on the redirect response.
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
 * Read the caller's browser identity without ever setting one.
 *
 * For read-only server contexts — a Server Component like the home page — where setting a cookie is
 * not allowed anyway. A browser that has not created anything yet simply has no `cid`, and gets
 * undefined, which is correct: it has no holds of its own to resume.
 */
export async function readClientId(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE)?.value;
}

/**
 * Pull the `cid` out of a raw request's Cookie header, without touching `next/headers`.
 *
 * The JSON API route uses this rather than `cookies()` for two reasons: it never needs to *set* the
 * cookie (it is a programmatic surface, and minting an identity there is not the flow being fixed),
 * and reading the header directly keeps the route callable as a plain function in tests, where
 * `next/headers` has no request scope to read from. A browser hitting the API with a `cid` still
 * gets dedup; a cookie-less curl request just gets undefined and the old behaviour.
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
