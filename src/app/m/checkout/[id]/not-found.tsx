import Link from "next/link";
import { copy } from "@/lib/copy";

/** The same thing a deep link into a dead session hits, in the phone frame. */
export default function MobileCheckoutNotFound() {
  return (
    <div className="phone-wrap">
      <main className="phone">
        <span className="surface-tag">mobile · deep link</span>
        <h1>{copy.notFound.checkout.title}</h1>
        <p className="muted">{copy.notFound.checkout.mobile}</p>
        <Link className="button" href="/">{copy.notFound.browse}</Link>
      </main>
    </div>
  );
}
