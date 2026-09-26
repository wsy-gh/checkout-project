"use client";

import { duration } from "@/lib/format";
import { useElapsed } from "./useElapsed";

/**
 * "starts in 25 min", counting down — and once the event begins, "started 5 min ago" in red.
 *
 * Appears on the home page and on each listing page. The server supplies when the event
 * starts and what time it currently thinks it is; useElapsed.ts supplies the ticking. That
 * split is what makes the first rendering correct before any JavaScript runs, and what keeps
 * the number honest afterwards regardless of what the device's own clock is doing.
 *
 * Everything here is a duration between two instants rather than a time of day, which is
 * exactly why this app never needs to know what timezone anyone is in.
 */
export function EventTime({ startsAt, serverNow }: { startsAt: number; serverNow: number }) {
  const untilStart = startsAt - serverNow - useElapsed();
  const started = untilStart <= 0;

  return (
    <span className={started ? "event-time started" : "event-time"}>
      {started ? `started ${duration(-untilStart)} ago` : `starts in ${duration(untilStart)}`}
    </span>
  );
}
