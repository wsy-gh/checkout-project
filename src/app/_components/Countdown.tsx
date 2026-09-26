"use client";

import { useEffect, useState } from "react";

/**
 * A countdown that is correct before JavaScript runs and never trusts the device clock.
 *
 * The first render (server and hydration) uses `expiresAt - serverNow`, so the HTML and the
 * hydrated tree match. Ticking starts in an effect, using a skew computed once from the
 * server's clock, so a device that is five minutes fast still shows the right number.
 */
export function Countdown({ expiresAt, serverNow }: { expiresAt: number; serverNow: number }) {
  const [left, setLeft] = useState(expiresAt - serverNow);

  useEffect(() => {
    const skew = Date.now() - serverNow;
    const tick = () => setLeft(expiresAt - (Date.now() - skew));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [expiresAt, serverNow]);

  const ms = Math.max(0, left);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const urgent = ms < 2 * 60000;

  return (
    <div className={`countdown${urgent ? " urgent" : ""}`} aria-live={urgent ? "polite" : "off"} aria-atomic="true">
      {ms === 0 ? "Hold ended" : `${m}:${s.toString().padStart(2, "0")}`}
      <span className="muted" style={{ fontSize: 14, fontWeight: 400, marginLeft: 8 }}>
        {ms === 0 ? "— refresh to continue" : "left on your hold"}
      </span>
    </div>
  );
}
