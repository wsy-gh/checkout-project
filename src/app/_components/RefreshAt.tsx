"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * RE-RENDER THE PAGE ONCE A DEADLINE THE SERVER SET HAS PASSED.
 *
 * Since the home page (src/app/page.tsx) shows a "you have a hold in progress" banner and its seat
 * counts but, unlike the checkout pages, has no SessionSync keeping it current, two things there
 * would quietly go wrong the moment a hold ran out — the banner would keep offering to resume a
 * checkout that had ended, and the "N seats left" counts would stay one short. This component fixes
 * both by waiting out the remaining time and asking the server again.
 *
 * The way it fixes them is a small demonstration of how the whole app handles expiry: the re-render
 * calls `sweepExpired`, which notices the deadline passed, returns the seats, and drops the session
 * from the resumable list — so the banner disappears and the seat count goes up, with no background
 * job anywhere.
 *
 * The delay is measured from when this component mounts rather than read off the wall clock, for the
 * reasons explained in useElapsed.ts, plus a small margin so the server is certainly past the
 * deadline by the time we ask.
 */
export function RefreshAt({ deadline, serverNow }: { deadline: number; serverNow: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => router.refresh(), Math.max(0, deadline - serverNow) + 500);
    return () => clearTimeout(timer);
  }, [deadline, serverNow, router]);

  return null;
}
