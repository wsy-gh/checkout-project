"use client";

import { duration } from "@/lib/format";
import { useElapsed } from "./useElapsed";

/**
 * "Starts in 25 min", counting down, then "started 5 min ago" in red. Split like the hold countdown:
 * the server supplies both instants and useElapsed supplies the ticking, so the first render is
 * correct before any JavaScript runs and stays honest regardless of the device's clock. Everything
 * is a duration between two instants rather than a time of day, which is why this app never needs to
 * know anyone's timezone.
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
