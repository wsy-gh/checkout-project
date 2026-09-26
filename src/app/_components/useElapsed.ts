"use client";

import { useEffect, useState } from "react";

/**
 * How many milliseconds have passed since this component appeared on screen, updated once a
 * second.
 *
 * Both timers in the app are built on this: the hold countdown in Countdown.tsx and the
 * "starts in 25 min" clock in EventTime.tsx. Both work the same way — the server sends the
 * two numbers that matter, and this hook supplies the ticking.
 *
 * WHY NOT JUST READ THE CLOCK?
 *
 * The obvious version of a countdown reads the current time on every tick and subtracts.
 * The problem is that the current time can move underneath you, in ways that have nothing to
 * do with time actually passing.
 *
 * Changing timezone is the harmless case, and worth being clear about: `Date.now()` counts
 * milliseconds since a fixed instant in 1970, measured the same way everywhere on Earth.
 * Flying from New York to London does not change it, and neither does a daylight-saving
 * switch. Those only affect how a moment is *displayed*, and this app never displays a
 * moment — only durations.
 *
 * The case that does bite is the phone correcting itself. Land, reconnect, and the operating
 * system re-syncs its clock with the network, which can jump it by seconds or minutes in
 * either direction. A countdown doing arithmetic on that clock jumps with it, and a fan
 * watches their remaining time lurch for no reason.
 *
 * `performance.now()` avoids all of it. It measures time since the page opened and is
 * guaranteed to only ever move forward at a steady rate — no clock correction, timezone
 * change or daylight-saving switch touches it. It also keeps counting while a tab is in the
 * background, so if the browser throttles our interval and skips ticks, the next tick still
 * reports the true elapsed time instead of drifting behind.
 *
 * WHAT IT DELIBERATELY CANNOT SEE
 *
 * Time that passed while the page was frozen in the browser's back/forward cache. That is
 * SessionSync.tsx's job: it refetches when a frozen page is restored, which replaces the
 * server's numbers and restarts this count from scratch.
 *
 * Returning 0 on the first render is what keeps server and browser agreeing. The server has
 * no `performance.now()` and never runs the effect below, so it renders the untouched
 * starting value; the browser's first render matches it exactly, and only then does the
 * ticking begin.
 */
export function useElapsed(intervalMs = 1000): number {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = performance.now();
    const tick = () => setElapsed(performance.now() - start);
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return elapsed;
}
