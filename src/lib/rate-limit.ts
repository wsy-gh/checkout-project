/**
 * A FIXED-WINDOW RATE LIMITER
 *
 * Creating a hold takes seats off the market and costs the caller nothing, which makes it the
 * one operation here that is worth abusing: a loop over `POST /api/sessions` can deny an
 * event's inventory to everyone else without ever paying for a ticket. Nothing else in this
 * API has that shape — reads change nothing, and paying requires a hold you already own.
 *
 *
 * HOW IT WORKS, AND WHY THE SIMPLEST VERSION IS THE RIGHT ONE HERE
 *
 * Each caller gets a counter and a deadline. Requests increment the counter; when the
 * deadline passes, both reset. That is a "fixed window", and its well-known flaw is the
 * boundary: a caller can spend a full allowance at the end of one window and another at the
 * start of the next, so the true worst case over a short span is double the limit.
 *
 * A sliding window or a token bucket fixes that and costs more code and more memory. It is
 * not worth it here, because the limit is not a precise budget — it is a ceiling that turns
 * "unbounded" into "bounded", and 2N is just as bounded as N. Sizing the limit to half of
 * what you can tolerate is the entire mitigation.
 *
 *
 * WHAT THIS DELIBERATELY IS NOT
 *
 * It is not a cap on how many holds one person may have at once, which is the limit you
 * actually want. That needs a durable notion of who someone is, and this app has no auth — an
 * IP address is a guess, shared by everyone behind one office router and changed by anyone
 * with a phone. Rate limiting bounds the *speed* of bulk denial; only identity bounds its
 * *total*. That gap is named in the README rather than papered over.
 *
 * It is also per-process, like everything else in this prototype. In production a rate
 * limiter belongs at the edge — a CDN or gateway — where it sees every request rather than
 * the share that reached one server.
 */
export type RateLimiter = {
  /** Record one attempt. False means the caller is over their allowance. */
  take(key: string): boolean;
  reset(): void;
};

export function createRateLimiter({
  limit,
  windowMs,
  now,
}: {
  limit: number;
  windowMs: number;
  /** Injected so tests and the demo's clock knob move the window too. */
  now: () => number;
}): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return {
    take(key: string) {
      const at = now();
      const current = windows.get(key);

      if (!current || at >= current.resetAt) {
        // Expiry is noticed on read here, exactly as it is for holds — so there is no
        // sweeper, and no window where the deadline has passed but the reset has not run.
        // The map is swept opportunistically below rather than by a timer.
        if (windows.size > 10_000) for (const [k, w] of windows) if (at >= w.resetAt) windows.delete(k);
        windows.set(key, { count: 1, resetAt: at + windowMs });
        return true;
      }

      current.count += 1;
      return current.count <= limit;
    },
    reset() {
      windows.clear();
    },
  };
}

/**
 * Who is asking, as well as this app can tell.
 *
 * Behind a proxy the socket address is the proxy's, so the caller's address is whatever the
 * proxy wrote into `x-forwarded-for` — the first entry, since each hop appends. Both headers
 * are trivially forged by a client talking to the server directly, which is why a real
 * deployment does this at the edge instead. Everything unidentifiable shares one bucket,
 * which is the safe direction to be wrong in: it over-limits rather than under-limits.
 */
export function callerKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
