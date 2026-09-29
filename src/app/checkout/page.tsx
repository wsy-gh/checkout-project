import Link from "next/link";
import { redirect } from "next/navigation";
import { checkout } from "@/lib/checkout";
import { readClientId } from "@/lib/client-id";
import { asSurface } from "@/lib/input";
import { checkoutPath } from "@/lib/routes";

// Reads the `cid` cookie and live holds, so it must render fresh on every request.
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ surface?: string }> };

/**
 * `/checkout` with no id — "take me to my checkout". With no id in the URL, the `cid` cookie is the
 * only thing that can point at the right session, so a returning browser with a live hold is sent
 * straight to it. No cookie or no live hold means there is nothing to resume, and guessing at a
 * session that might be someone else's would be a hijack, so it shows an empty state instead.
 * Only reads the cookie: setting one is not allowed while rendering a page.
 */
export default async function CheckoutIndex({ searchParams }: Props) {
  // Carried through the redirect, so `?surface=mobile` lands on the resumed session in its mobile
  // presentation rather than silently dropping to web.
  const surface = asSurface((await searchParams).surface) ?? "web";
  const cid = await readClientId();
  if (cid) {
    const [resume] = checkout.resumable(cid);
    if (resume) redirect(checkoutPath(resume.id, surface));
  }

  return (
    <main className="web">
      <h1>Empty checkout</h1>
      <p className="muted">
        You don&apos;t have a hold in progress. Anything you were holding has been released back for
        other fans — pick an event to start a new checkout.
      </p>
      <Link className="button" href="/">Browse events</Link>
    </main>
  );
}
