import Link from "next/link";

/**
 * One screen for both surfaces, since Next renders `not-found.tsx` without the search params that
 * would say which asked. A checkout we cannot find is far more often an old or mistyped link than a
 * real order, so the copy must not imply the fan lost anything.
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
