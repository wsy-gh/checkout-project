import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/checkout/types";
import { resetAll, stubs } from "@/lib/checkout";
import { POST as createRoute } from "@/app/api/sessions/route";
import { GET as getRoute } from "@/app/api/sessions/[id]/route";
import { POST as completeRoute } from "@/app/api/sessions/[id]/complete/route";
import { POST as acceptPriceRoute } from "@/app/api/sessions/[id]/accept-price/route";
import { POST as reholdRoute } from "@/app/api/sessions/[id]/rehold/route";
import { GET as debugGet, POST as debugPost } from "@/app/api/debug/[knob]/route";

/**
 * THE HTTP BOUNDARY
 *
 * Everything in scenarios.test.ts and concurrency.test.ts calls the domain directly, which is
 * the right place to test what the rules *are*. This file tests the part those cannot see: the
 * translation between an HTTP request and a domain call, which is where a correct state
 * machine still gets handed to clients wrongly.
 *
 * Three things only exist at this layer, and all three are load-bearing claims in the README:
 *
 *   THE STATUS CODE. A client that checks `res.ok` before reading the body — which is most of
 *   them, and every `fetch` wrapper — sees only this. A 200 carrying a failed session is a
 *   success to that client. `codes` below pins the whole table.
 *
 *   THE ENVELOPE. "Every response carries the full session, whether the request succeeded or
 *   not." That is what lets a surface redraw from any rejection without a second request, and
 *   it is asserted here against every response these tests produce rather than claimed in
 *   prose.
 *
 *   `no-store`. A cached checkout page or API reply is a lie the moment anything happens.
 *
 * The route handlers are called as plain functions, the way Next.js calls them. No server, no
 * port, no fetch — so these run in the same few milliseconds as the rest of the suite. The one
 * thing that costs is state: these share the process-wide singleton from src/lib/checkout.ts
 * (the real one the app uses, not a fixture), so `resetAll` runs before each test.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };

const post = (path: string, body?: unknown) =>
  new Request(`http://t${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const get = (path: string) => new Request(`http://t${path}`);

/** Next.js hands route handlers their path params as a promise. */
const ctx = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

type Envelope = {
  session?: Session;
  serverNow?: number;
  code?: string;
  priceChange?: { from: number; to: number; newPriceVersion: number };
  alternatives?: { id: string }[];
};

/**
 * Read a response, and assert the two things that must be true of *every* reply from the
 * session API before returning it. Putting them here rather than in one test means no route
 * can quietly stop honouring them: every call in this file checks them by construction.
 */
async function read(res: Response) {
  const body = (await res.json()) as Envelope;
  expect(res.headers.get("cache-control")).toBe("no-store");
  // A rejection without a code, or any reply without the session, would force a client into a
  // second request to find out where it stands.
  if (res.status >= 400) expect(body.code).toBeTruthy();
  expect(body.session).toBeTruthy();
  expect(typeof body.serverNow).toBe("number");
  return { status: res.status, body, session: body.session as Session };
}

/** Start a checkout the way a client does, and hand back what it would hold. */
async function start(listingId = "L1", quantity = 1, surface = "web") {
  const { status, session } = await read(await createRoute(post("/api/sessions", { listingId, quantity, surface })));
  expect(status).toBe(201);
  return session;
}

const payBody = (s: Session, idempotencyKey = "k1", surface = "web") => ({
  version: s.version,
  priceVersion: s.priceVersion,
  idempotencyKey,
  paymentToken: "tok_test",
  surface,
});

const pay = (s: Session, key?: string, surface?: string) =>
  completeRoute(post(`/api/sessions/${s.id}/complete`, payBody(s, key, surface)), ctx({ id: s.id }));

const resume = (id: string, surface?: string) =>
  getRoute(get(`/api/sessions/${id}${surface ? `?surface=${surface}` : ""}`), ctx({ id }));

const MIN = 60_000;

beforeEach(() => resetAll());

describe("the cross-surface flow, over HTTP", () => {
  it("create on web → resume on mobile → complete: three requests, one session", async () => {
    const created = await start("L1", 2, "web");
    expect(created.status).toBe("ACTIVE");
    expect(created.quantity).toBe(2);
    expect(stubs.inventory.get("L1").available).toBe(2);

    // The second surface sends nothing but the ID. This is the whole of "resume".
    const resumed = await read(await resume(created.id, "mobile"));
    expect(resumed.status).toBe(200);
    expect(resumed.session.id).toBe(created.id);
    expect(resumed.session.quotedTotal).toBe(created.quotedTotal);
    expect(resumed.session.lastSeenOn).toBe("mobile");

    const paid = await read(await pay(resumed.session, "mobile-1", "mobile"));
    expect(paid.status).toBe(200);
    expect(paid.session.status).toBe("COMPLETED");
    expect(paid.session.status === "COMPLETED" && paid.session.orderId).toMatch(/^ord_/);
  });

  it("a read from the other surface does not invalidate the first surface's version", async () => {
    const s = await start();
    await resume(s.id, "mobile"); // telemetry only — must not bump `version`
    expect((await read(await pay(s))).session.status).toBe("COMPLETED");
  });

  it("the price change rides along on the resume, so one request is enough to draw the screen", async () => {
    const s = await start("L1", 1, "web");
    stubs.pricing.setTotal("L1", 9900);

    const resumed = await read(await resume(s.id, "mobile"));
    expect(resumed.body.priceChange).toEqual({ from: 8900, to: 9900, newPriceVersion: 2 });

    const refused = await read(await pay(resumed.session));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("PRICE_CHANGED");

    const accepted = await read(
      await acceptPriceRoute(
        post(`/api/sessions/${s.id}/accept-price`, { version: resumed.session.version, priceVersion: 2, surface: "mobile" }),
        ctx({ id: s.id }),
      ),
    );
    expect(accepted.status).toBe(200);
    expect(accepted.session.quotedTotal).toBe(9900);
    expect((await read(await pay(accepted.session))).session.status).toBe("COMPLETED");
  });

  it("rehold hands back a different session, and the old one points at it", async () => {
    const s = await start("L1");
    stubs.clock.advance(11 * MIN);
    expect((await read(await resume(s.id))).session.status).toBe("EXPIRED");

    const next = await read(await reholdRoute(post(`/api/sessions/${s.id}/rehold`), ctx({ id: s.id })));
    expect(next.status).toBe(200);
    expect(next.session.id).not.toBe(s.id);
    expect(next.session.status).toBe("ACTIVE");

    const old = await read(await resume(s.id));
    expect(old.session.status === "EXPIRED" && old.session.successorSessionId).toBe(next.session.id);
  });

  it("a withdrawn listing answers with somewhere else to go", async () => {
    const s = await start("L1");
    stubs.inventory.withdraw("L1");
    const failed = await read(await resume(s.id, "mobile"));
    expect(failed.session.status).toBe("FAILED");

    const refused = await read(await pay(s));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("INVENTORY_WITHDRAWN");
    expect(refused.body.alternatives?.map((a) => a.id)).toEqual(["L2", "L3"]);
  });
});

/**
 * The status code is the part of the contract a client reads before anything else, so it gets
 * a table of its own. Every row is a rejection the UI has a screen for; if a code here moves,
 * a client that branches on `res.status` changes behaviour without any test failing elsewhere.
 */
describe("status codes", () => {
  it("404 for a session that does not exist", async () => {
    const res = await resume("cs_nope");
    expect(res.status).toBe(404);
    // No session to carry, so this is the one reply that cannot satisfy the envelope rule.
    expect(((await res.json()) as Envelope).code).toBe("NOT_FOUND");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("400 when the quantity is not a quantity", async () => {
    for (const quantity of ["abc", 0, -1, 1.5, null]) {
      const res = await createRoute(post("/api/sessions", { listingId: "L1", quantity, surface: "web" }));
      expect(res.status).toBe(400);
      expect(((await res.json()) as Envelope).code).toBe("INVALID_REQUEST");
    }
    expect(stubs.inventory.get("L1").available).toBe(4); // the counter was never touched
  });

  it("400 when the pay request carries no idempotency key", async () => {
    const s = await start();
    const res = await completeRoute(
      post(`/api/sessions/${s.id}/complete`, { version: s.version, priceVersion: s.priceVersion }),
      ctx({ id: s.id }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe("INVALID_REQUEST");
  });

  it("409 STALE_VERSION when the device is looking at an older session", async () => {
    const s = await start("L1");
    stubs.pricing.setTotal("L1", 9900);
    await acceptPriceRoute(
      post(`/api/sessions/${s.id}/accept-price`, { version: s.version, priceVersion: 2, surface: "mobile" }),
      ctx({ id: s.id }),
    );
    const refused = await read(await pay(s)); // the web tab still holds the pre-accept version
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("STALE_VERSION");
    expect(refused.session.version).toBeGreaterThan(s.version); // ...and it is told the truth
  });

  it("409 EXPIRED when the hold ran out before the press landed", async () => {
    const s = await start("L1");
    stubs.clock.advance(11 * MIN);
    const refused = await read(await pay(s));
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("EXPIRED");
    expect(stubs.inventory.get("L1").available).toBe(4);
  });

  it("409 IN_PROGRESS_ELSEWHERE for the second device", async () => {
    const s = await start("L1");
    stubs.payments.nextResult = "unknown";
    expect((await read(await pay(s, "device-a"))).session.status).toBe("PAYMENT_PENDING");

    const second = await read(await pay(s, "device-b", "mobile"));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("IN_PROGRESS_ELSEWHERE");
  });

  it("409 SOLD_OUT when a rehold finds the seats gone", async () => {
    const s = await start("L3"); // L3 has exactly one seat
    stubs.clock.advance(11 * MIN);
    await resume(s.id); // notice the expiry, seat goes back
    await start("L3"); // another fan takes it

    const res = await reholdRoute(post(`/api/sessions/${s.id}/rehold`), ctx({ id: s.id }));
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(409);
    expect(body.code).toBe("SOLD_OUT");
  });

  it("402 PAYMENT_DECLINED, and the replay of it is also a 402", async () => {
    const s = await start("L1");
    stubs.payments.nextResult = "declined";

    const declined = await read(await pay(s, "k-declined"));
    expect(declined.status).toBe(402);
    expect(declined.session.status).toBe("FAILED");
    expect(stubs.inventory.get("L1").available).toBe(4);

    // The same attempt arriving twice must not answer 200. A client reading only the status
    // code would show a confirmation for a card that was refused.
    const replay = await read(await pay(s, "k-declined"));
    expect(replay.status).toBe(402);
    expect(stubs.events.all().filter((e) => e.name === "payment_started")).toHaveLength(1);
  });

  it("200 and the same order for a retry of an attempt that worked", async () => {
    const s = await start("L1");
    const first = await read(await pay(s, "one-form"));
    const retry = await read(await pay(s, "one-form"));
    expect([first.status, retry.status]).toEqual([200, 200]);
    expect(retry.session.status === "COMPLETED" && retry.session.orderId).toBe(
      first.session.status === "COMPLETED" ? first.session.orderId : null,
    );
    expect(stubs.events.all().filter((e) => e.name === "completed")).toHaveLength(1);
  });

  it("409, not 200, when the charge lands on a session the timeout already failed", async () => {
    // The reconcile conflict, seen from a client. The session is FAILED and a refund is owed;
    // answering 200 with it would read as a completed purchase to anything that checks the
    // status code first. See `answer` in src/checkout/service.ts.
    const s = await start("L1");
    stubs.payments.delayMs = 20;
    const paying = pay(s, "slow");
    await new Promise((r) => setTimeout(r, 5)); // let it get past the flip and into the charge

    stubs.clock.advance(3 * MIN);
    expect((await read(await resume(s.id, "mobile"))).session.status).toBe("FAILED");

    const late = await read(await paying);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe("ALREADY_FAILED");
    expect(late.session.status === "FAILED" && late.session.failReason).toBe("PENDING_TIMEOUT");
    expect(stubs.events.all().filter((e) => e.name === "reconcile_conflict")).toHaveLength(1);
  });

  it("every shape of unusable body is a 400, never a 500", async () => {
    // `null` is the one that used to crash. JSON.parse succeeds on it and it is not an
    // object, so a try/catch around the parse lets it through and the first property access
    // throws: "Cannot read properties of null (reading 'listingId')" — a 500 on a two-word
    // request. The others are valid JSON that is still not a set of fields.
    for (const body of ["}{ not json", "", "null", "[]", '"just a string"', "42"]) {
      const res = await createRoute(post("/api/sessions", body));
      expect(res.status, `body: ${body}`).toBe(400);
      expect(((await res.json()) as Envelope).code).toBe("INVALID_REQUEST");
    }
  });

  it("refuses a body too large to be legitimate", async () => {
    // Every field this API takes is a short scalar, so there is no size at which a bigger
    // body becomes useful. A 10MB one was previously read in full and answered 201.
    const huge = JSON.stringify({ listingId: "L1", quantity: 1, pad: "A".repeat(200_000) });
    const res = await createRoute(post("/api/sessions", huge));
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe("INVALID_REQUEST");
    expect(stubs.inventory.get("L1").available).toBe(4); // nothing was held
  });
});

/**
 * Values arriving from outside are recognised, never coerced.
 *
 * `String(["L1"])` is `"L1"` and `Number(true)` is `1`, so coercion turns requests that were
 * never valid into successful ones. Each of these was accepted before src/lib/input.ts.
 */
describe("input is recognised, not coerced", () => {
  it("refuses values that merely look number-ish", async () => {
    for (const quantity of [true, false, [5], {}, "abc", null, Infinity]) {
      const res = await createRoute(post("/api/sessions", { listingId: "L1", quantity, surface: "web" }));
      expect(res.status, `quantity: ${JSON.stringify(quantity)}`).toBe(400);
      expect(((await res.json()) as Envelope).code).toBe("INVALID_REQUEST");
    }
    // A form's <select> can only send a string, so a string that spells a number still works.
    expect((await read(await createRoute(post("/api/sessions", { listingId: "L1", quantity: "2" })))).session.quantity).toBe(2);
    expect(stubs.inventory.get("L1").available).toBe(2);
  });

  it("refuses a listing id that is not a string", async () => {
    for (const listingId of [["L1"], 123, {}, null, ""]) {
      const res = await createRoute(post("/api/sessions", { listingId, quantity: 1 }));
      expect(res.status, `listingId: ${JSON.stringify(listingId)}`).toBe(400);
    }
    expect(stubs.inventory.get("L1").available).toBe(4);
  });

  it("never stores an unrecognised surface", async () => {
    // This was a cast rather than a check, so `?surface=<script>x</script>` was written into
    // the session and echoed in the event log. Anything unrecognised is now simply absent.
    const s = await start("L1", 1, "web");
    for (const bad of ["EVIL", "<script>x</script>", "web ", "MOBILE", "x".repeat(500)]) {
      const resumed = await read(await resume(s.id, bad));
      expect(resumed.session.lastSeenOn).toBe("web"); // unchanged, not overwritten
    }
    expect(await read(await resume(s.id, "mobile"))).toBeTruthy();
    expect((await read(await resume(s.id, "mobile"))).session.lastSeenOn).toBe("mobile");

    const surfaces = new Set(stubs.events.all().map((e) => e.surface).filter(Boolean));
    expect([...surfaces].every((v) => v === "web" || v === "mobile")).toBe(true);
  });

  it("refuses an idempotency key that is not a usable string", async () => {
    const s = await start();
    for (const idempotencyKey of [{}, [1, 2], 42, true, "", null, "K".repeat(201)]) {
      const res = await completeRoute(
        post(`/api/sessions/${s.id}/complete`, { version: s.version, priceVersion: s.priceVersion, idempotencyKey, paymentToken: "t" }),
        ctx({ id: s.id }),
      );
      expect(res.status, `key: ${JSON.stringify(idempotencyKey)}`).toBe(400);
    }
    // The bug this closes: String({}) is "[object Object]", so every caller sending a
    // non-string key shared one key — and the second genuinely different attempt was handed
    // the first one's order as a replay.
    expect((await read(await resume(s.id))).session.status).toBe("ACTIVE");
  });

  it("requires a payment token rather than inventing one", async () => {
    // The stub ignores the token, so a missing one silently "worked" — and that same path
    // would attempt a charge against a placeholder the day a real provider is wired in.
    const s = await start();
    const res = await completeRoute(
      post(`/api/sessions/${s.id}/complete`, { version: s.version, priceVersion: s.priceVersion, idempotencyKey: "k" }),
      ctx({ id: s.id }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).code).toBe("INVALID_REQUEST");
  });

  it("does not forward unknown fields from the body into the domain", async () => {
    // accept-price used to spread `{ ...body }` into its input — mass assignment, harmless
    // only while the domain happened to ignore the extras.
    const s = await start("L1");
    stubs.pricing.setTotal("L1", 9900);
    const res = await acceptPriceRoute(
      post(`/api/sessions/${s.id}/accept-price`, {
        version: s.version,
        priceVersion: 2,
        surface: "INJECTED",
        quotedTotal: 1,
        status: "COMPLETED",
      }),
      ctx({ id: s.id }),
    );
    const after = (await res.json()) as Envelope;
    expect(after.session?.status).toBe("ACTIVE");
    expect(after.session?.quotedTotal).toBe(9900); // the real new price, not the injected 1
    expect(after.session?.lastSeenOn).toBe("web"); // not "INJECTED"
  });
});

describe("holds are rate limited", () => {
  it("lets a normal fan through and stops a loop", async () => {
    const caller = { "x-forwarded-for": "203.0.113.9" };
    const create = () =>
      createRoute(new Request("http://t/api/sessions", {
        method: "POST",
        headers: { ...JSON_HEADERS, ...caller },
        body: JSON.stringify({ listingId: "L1", quantity: 1 }),
      }));

    // The limit is 20/minute. L1 only has 4 seats, so the first few succeed and the rest are
    // SOLD_OUT — what matters is that the 21st is refused for a different reason entirely.
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) codes.push((await create()).status);
    expect(codes.slice(0, 20).every((c) => c !== 429)).toBe(true);
    expect(codes[20]).toBe(429);
    expect(codes[21]).toBe(429);

    // A different caller is unaffected — the limit is per caller, not global.
    const other = await createRoute(post("/api/sessions", { listingId: "L2", quantity: 1 }));
    expect(other.status).not.toBe(429);

    // And the window reopens. The limiter reads the same injected clock as everything else.
    stubs.clock.advance(61_000);
    expect((await create()).status).not.toBe(429);
  });

  it("answers 429 with a code, and holds nothing", async () => {
    const caller = { "x-forwarded-for": "198.51.100.4" };
    const create = () =>
      createRoute(new Request("http://t/api/sessions", {
        method: "POST",
        headers: { ...JSON_HEADERS, ...caller },
        body: JSON.stringify({ listingId: "L3", quantity: 1 }),
      }));
    for (let i = 0; i < 20; i++) await create();
    const res = await create();
    const body = (await res.json()) as Envelope;
    expect(res.status).toBe(429);
    expect(body.code).toBe("RATE_LIMITED");
    // A refusal that never reached the domain carries no session, which is the one case the
    // envelope rule cannot satisfy — it is about the caller, not about any one checkout.
    expect(body.session).toBeUndefined();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("the debug knobs", () => {
  it("serve the event log and the stub state", async () => {
    await start("L1");
    const events = await debugGet(get("/api/debug/events"), ctx({ knob: "events" }));
    expect(events.status).toBe(200);
    expect(((await events.json()) as { name: string }[]).map((e) => e.name)).toContain("session_created");

    const state = await debugGet(get("/api/debug/state"), ctx({ knob: "state" }));
    expect(((await state.json()) as { sessions: unknown[] }).sessions).toHaveLength(1);
  });

  it("move the server's clock", async () => {
    const before = stubs.clock.now();
    const res = await debugPost(post("/api/debug/advance", { ms: 5 * MIN }), ctx({ knob: "advance" }));
    expect(res.status).toBe(200);
    expect(stubs.clock.now() - before).toBeGreaterThanOrEqual(5 * MIN);
  });

  it("404 an unknown knob", async () => {
    expect((await debugPost(post("/api/debug/nope"), ctx({ knob: "nope" }))).status).toBe(404);
    expect((await debugGet(get("/api/debug/nope"), ctx({ knob: "nope" }))).status).toBe(404);
  });

  it("do not exist in a production build", async () => {
    // An unauthenticated route that resets every session must not merely be undocumented in
    // production. One POST to /reset would end every fan's checkout at once.
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect((await debugGet(get("/api/debug/events"), ctx({ knob: "events" }))).status).toBe(404);
      expect((await debugPost(post("/api/debug/reset"), ctx({ knob: "reset" }))).status).toBe(404);
      // And the state it guards is untouched by the attempt.
      expect(stubs.clock.now()).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
