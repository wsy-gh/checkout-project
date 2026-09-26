import { RecoveryState } from "@/app/_components/RecoveryState";
import { SessionMeta } from "@/app/_components/SessionMeta";
import { SurfaceLinks } from "@/app/_components/SurfaceLinks";
import { loadCheckoutPage } from "@/lib/page-data";

// A checkout page must never be served from a cache: it's the live state of a hold.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> };

/**
 * Web surface. A Server Component: the session, price, and a correct countdown are in the
 * HTML before any JavaScript runs. Hydration adds the countdown tick and the Pay button's
 * pending state — nothing the fan needs is gated on it.
 */
export default async function WebCheckout({ params, searchParams }: Props) {
  const [{ id }, { result }] = await Promise.all([params, searchParams]);
  const data = await loadCheckoutPage(id, "web");

  return (
    <main className="web">
      <span className="surface-tag">web</span>
      <RecoveryState {...data} surface="web" result={result} />
      <SessionMeta session={data.session} surface="web" />
      <SurfaceLinks session={data.session} surface="web" />
    </main>
  );
}
