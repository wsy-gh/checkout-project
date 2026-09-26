import Link from "next/link";
import { copy } from "@/lib/copy";

/**
 * An unknown session ID on the web surface. The copy must not imply the fan lost anything:
 * a checkout we cannot find is far more often an old or mistyped link than a real order.
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
