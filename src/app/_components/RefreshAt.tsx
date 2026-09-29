"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Re-renders the page once a server-set deadline passes. The home page has no SessionSync, so
 * without this its resume banner would keep offering a checkout that had ended and its seat counts
 * would stay one short. The re-render runs `sweepExpired`, which returns the seats and drops the
 * session from the resumable list — the banner goes, the count goes up, and no background job is
 * involved.
 *
 * The delay is measured from mount rather than off the wall clock (see useElapsed.ts), plus a margin
 * so the server is certainly past the deadline by the time we ask.
 */
export function RefreshAt({ deadline, serverNow }: { deadline: number; serverNow: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => router.refresh(), Math.max(0, deadline - serverNow) + 500);
    return () => clearTimeout(timer);
  }, [deadline, serverNow, router]);

  return null;
}
