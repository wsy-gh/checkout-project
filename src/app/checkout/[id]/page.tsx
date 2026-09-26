import Link from "next/link";
import { RecoveryState } from "@/app/_components/RecoveryState";
import { loadCheckoutPage } from "@/lib/page-data";

// A checkout page must never be served from a cache: it's the live state of a hold.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> };

/**
 * Web surface. This is a Server Component: the session, price, and a correct countdown
 * are in the HTML before any JavaScript runs. Hydration adds the countdown tick and the
 * Pay button's pending state — nothing the fan needs is gated on it.
 */
export default async function WebCheckout({ params, searchParams }: Props) {
  const [{ id }, { result }] = await Promise.all([params, searchParams]);
  const data = await loadCheckoutPage(id, "web");

  return (
    <main className="web">
      <span className="surface-tag">web</span>
      <RecoveryState {...data} surface="web" result={result} />
      <p className="meta">
        session {data.session.id} · v{data.session.version} · {data.session.status}
      </p>
      <p className="links">
        {/* Plain anchors on purpose: switching surface is a full server render, like a real device would do. */}
        <a href={`/m/checkout/${id}`}>Open this session on mobile →</a>
        <a href={`/deeplink/${id}`}>deep link</a>
        <Link href="/">home</Link>
      </p>
    </main>
  );
}
