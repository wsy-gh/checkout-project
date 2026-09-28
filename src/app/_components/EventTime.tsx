"use client";

import { duration } from "@/lib/format";
import { useElapsed } from "./useElapsed";

/**
 * "STARTS IN 25 MIN", COUNTING DOWN — and once the event begins, "started 5 min ago" in red.
 *
 * Appears on the home page and on each listing page. Since the number must be right before any
 * JavaScript runs and stay honest afterwards regardless of the device's own clock, the work is
 * split the same way the hold countdown is: the server supplies when the event starts and what time
 * it currently thinks it is, and useElapsed.ts supplies the ticking. That split is what makes the
 * first rendering correct on its own. Everything here is a duration between two instants rather than
 * a time of day, which is exactly why this app never needs to know what timezone anyone is in.
 */
export function EventTime({ startsAt, serverNow }: { startsAt: number; serverNow: number }) {
  const untilStart = startsAt - serverNow - useElapsed(serverNow);
  const started = untilStart <= 0;

  return (
    <span className={started ? "event-time started" : "event-time"}>
      {started ? `started ${duration(-untilStart)} ago` : `starts in ${duration(untilStart)}`}
    </span>
  );
}
