import { redirect } from "next/navigation";
import { RecoveryState } from "@/app/_components/RecoveryState";
import { SessionMeta } from "@/app/_components/SessionMeta";
import { SurfaceLinks } from "@/app/_components/SurfaceLinks";
import { checkout } from "@/lib/checkout";
import { readClientId } from "@/lib/client-id";
import { asSurface } from "@/lib/input";
import { loadCheckoutPage } from "@/lib/load-checkout-page";
import { checkoutPath } from "@/lib/routes";

// The live state of a hold, so it must never be served from a cache.
export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ result?: string; surface?: string }>;
};

/**
 * The checkout page for both surfaces: one route, with `?surface=mobile` picking the phone
 * presentation. Taking the surface from the URL is not a hole in "nothing on the device is
 * authoritative" — authority is about seats, price and deadlines, all read from the session, while
 * surface only chooses a stylesheet and a wording variant, falling back to web if unrecognised.
 *
 * A Server Component, so the session, price and a correct countdown are in the HTML before any
 * JavaScript runs; hydration only adds the countdown tick and the Pay button's pending state.
 */
export default async function Checkout({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const surface = asSurface(query.surface) ?? "web";
  const data = await loadCheckoutPage(id, surface);

  // A stale history link can point at a hold that has since expired, so if this browser has a live
  // hold of its own, send them there rather than to the dead end. Same listing is preferred, the
  // usual case being that they pressed "Try again" and this is the successor. Only EXPIRED
  // redirects: COMPLETED and FAILED must keep showing their own screen, and ACTIVE is what they came
  // for. `resumable` is scoped to their `cid`, so this can only ever reach their own hold.
  if (data.session.status === "EXPIRED") {
    const cid = await readClientId();
    if (cid) {
      const live = checkout.resumable(cid);
      const target = live.find((s) => s.listingId === data.session.listingId) ?? live[0];
      if (target) redirect(checkoutPath(target.id, surface));
    }
  }

  const screen = (
    <>
      <span className="surface-tag">{surface === "mobile" ? "mobile · deep link" : "web"}</span>
      <RecoveryState {...data} surface={surface} result={query.result} />
      <SessionMeta session={data.session} surface={surface} />
      <SurfaceLinks session={data.session} surface={surface} />
    </>
  );

  // Besides wording, the frame is the only difference between the surfaces.
  return surface === "mobile" ? (
    <div className="phone-wrap">
      <main className="phone">{screen}</main>
    </div>
  ) : (
    <main className="web">{screen}</main>
  );
}
