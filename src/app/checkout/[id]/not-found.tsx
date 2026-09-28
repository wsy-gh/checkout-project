import Link from "next/link";

/**
 * AN UNKNOWN SESSION ID, ON EITHER SURFACE.
 *
 * Since Next.js renders `not-found.tsx` without the search params that would say which surface
 * asked, this is deliberately one screen for both. The copy that matters is the same either way: a
 * checkout we cannot find is far more often an old or mistyped link than a real order, so it must not
 * imply the fan lost anything.
 */
export default function CheckoutNotFound() {
  return (
    <main className="web">
      <h1>We couldn&apos;t find that checkout</h1>
      <p className="muted">The link may be old or mistyped. Your tickets and payments are unaffected.</p>
      <Link className="button" href="/">Browse events</Link>
    </main>
  );
}
