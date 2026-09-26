"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-render the page once a deadline the server set has passed.
 *
 * Used once, on the home page (src/app/page.tsx), for the "you have a hold in progress"
 * banner. Checkout pages keep themselves current through SessionSync.tsx; the home page has
 * no such thing, so two things there would quietly go wrong the moment a hold ran out. The
 * banner would keep offering to resume a checkout that had ended, and the "N seats left"
 * counts would stay one short.
 *
 * Waiting out the remaining time and asking the server again fixes both at once, and the
 * result is a small demonstration of how the whole app handles expiry: the re-render calls
 * `sweepExpired`, which notices the deadline passed, returns the seats, and drops the
 * session from the resumable list. The banner disappears and the seat count goes up, with
 * no background job anywhere.
 *
 * The delay is measured from when this mounts rather than read off the clock, for the
 * reasons explained in useElapsed.ts, plus a small margin so the server is certainly past
 * the deadline by the time we ask.
 */
export function RefreshAt({ deadline, serverNow }: { deadline: number; serverNow: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => router.refresh(), Math.max(0, deadline - serverNow) + 500);
    return () => clearTimeout(timer);
  }, [deadline, serverNow, router]);

  return null;
}
