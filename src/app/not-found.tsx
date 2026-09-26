import Link from "next/link";

/** A deep link for an unknown session lands here. The copy must not imply data loss. */
export default function NotFound() {
  return (
    <main className="web">
      <h1>We couldn&apos;t find that checkout</h1>
      <p className="muted">The link may be old or mistyped. Your tickets and payments are unaffected.</p>
      <Link className="button" href="/">Browse events</Link>
    </main>
  );
}
