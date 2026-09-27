import Link from "next/link";
import { copy } from "@/lib/copy";

/**
 * An unknown session ID, on either surface.
 *
 * Next.js renders `not-found.tsx` without the search params that would say which surface
 * asked, so this is deliberately one screen for both. That costs the phone-specific wording
 * the two-route version had, and buys never having two files that can drift apart. The copy
 * that matters is the same either way: a checkout we cannot find is far more often an old or
 * mistyped link than a real order, so it must not imply the fan lost anything.
 */
export default function CheckoutNotFound() {
  return (
    <main className="web">
      <h1>{copy.notFound.checkout.title}</h1>
      <p className="muted">{copy.notFound.checkout.web}</p>
      <Link className="button" href="/">{copy.notFound.browse}</Link>
    </main>
  );
}
