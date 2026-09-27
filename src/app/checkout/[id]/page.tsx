import { RecoveryState } from "@/app/_components/RecoveryState";
import { SessionMeta } from "@/app/_components/SessionMeta";
import { SurfaceLinks } from "@/app/_components/SurfaceLinks";
import { asSurface } from "@/lib/input";
import { loadCheckoutPage } from "@/lib/page-data";

// A checkout page must never be served from a cache: it's the live state of a hold.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ result?: string; surface?: string }>;
};

/**
 * THE CHECKOUT PAGE — BOTH SURFACES
 *
 * One route, and `?surface=mobile` picks the phone presentation. There used to be two routes,
 * `/checkout/:id` and `/m/checkout/:id`, which were two nearly identical files differing in a
 * CSS wrapper and a wording flag. Collapsing them makes the project's own claim literal
 * instead of merely true: there is one page and one loader, and the surface decides how it is
 * dressed — nothing else.
 *
 * That the surface now comes from the URL is not a hole in "nothing on the device is
 * authoritative". Authority is about seats, price and deadlines, all of which are read from
 * the session. `surface` chooses a stylesheet and a wording variant, and an unrecognised value
 * falls back to web rather than erroring, so a mangled deep link degrades to the ordinary
 * checkout page.
 *
 * A Server Component: the session, price, and a correct countdown are in the HTML before any
 * JavaScript runs. Hydration adds the countdown tick and the Pay button's pending state —
 * nothing the fan needs is gated on it.
 */
export default async function Checkout({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const surface = asSurface(query.surface) ?? "web";
  const data = await loadCheckoutPage(id, surface);

  const screen = (
    <>
      <span className="surface-tag">{surface === "mobile" ? "mobile · deep link" : "web"}</span>
      <RecoveryState {...data} surface={surface} result={query.result} />
      <SessionMeta session={data.session} surface={surface} />
      <SurfaceLinks session={data.session} surface={surface} />
    </>
  );

  // The only thing the two surfaces disagree about, besides wording: the phone gets a frame.
  return surface === "mobile" ? (
    <div className="phone-wrap">
      <main className="phone">{screen}</main>
    </div>
  ) : (
    <main className="web">{screen}</main>
  );
}
