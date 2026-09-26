import Link from "next/link";
import { copy } from "@/lib/copy";

/** Any URL that matches no route. Checkout routes have their own, with the right copy. */
export default function NotFound() {
  return (
    <main className="web">
      <h1>{copy.notFound.page.title}</h1>
      <p className="muted">{copy.notFound.page.body}</p>
      <Link className="button" href="/">{copy.notFound.browse}</Link>
    </main>
  );
}
