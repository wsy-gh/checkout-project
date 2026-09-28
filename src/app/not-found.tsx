import Link from "next/link";

/** Any URL that matches no route. Checkout routes have their own, with the right copy. */
export default function NotFound() {
  return (
    <main className="web">
      <h1>Page not found</h1>
      <p className="muted">That link doesn&apos;t point anywhere in this app.</p>
      <Link className="button" href="/">Browse events</Link>
    </main>
  );
}
