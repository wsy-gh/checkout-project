import { RecoveryState } from "@/app/_components/RecoveryState";
import { loadCheckoutPage } from "@/lib/page-data";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ result?: string }> };

/**
 * Simulated mobile surface: the same session, loaded by the same function, rendered in a
 * phone frame with mobile copy. A deep link (`gametime://checkout/:id`) resolves here.
 */
export default async function MobileCheckout({ params, searchParams }: Props) {
  const [{ id }, { result }] = await Promise.all([params, searchParams]);
  const data = await loadCheckoutPage(id, "mobile");

  return (
    <div className="phone-wrap">
      <main className="phone">
        <span className="surface-tag">mobile · deep link</span>
        <RecoveryState {...data} surface="mobile" result={result} />
        <p className="meta">
          {data.session.id} · v{data.session.version} · {data.session.status}
        </p>
        <p className="links">
          <a href={`/checkout/${id}`}>← back to web</a>
        </p>
      </main>
    </div>
  );
}
