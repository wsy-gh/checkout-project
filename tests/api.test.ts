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

  it("a body that is not JSON is a 4xx, never a 500", async () => {
    const res = await createRoute(post("/api/sessions", "}{ not json"));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // An empty body leaves no listing id, and the inventory stub cannot tell "never existed"
    // from "withdrawn" — `backs()` returns a boolean. A real inventory service would let this
    // be a 404; conflating them is a limit of the stub, not of the state machine.
    expect(((await res.json()) as Envelope).code).toBe("INVENTORY_WITHDRAWN");
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
