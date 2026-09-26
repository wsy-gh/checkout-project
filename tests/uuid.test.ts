import { describe, expect, it } from "vitest";
import { uuidv7, uuidv7Time } from "@/lib/uuid";

/**
 * The bits that make a UUIDv7 a UUIDv7.
 *
 * Worth testing rather than eyeballing, because every wrong version of this function still
 * produces a string that looks exactly like a UUID. `crypto.randomUUID({ version: 7 })`
 * returns a perfectly well-formed v4 and no error — which is the mistake this file exists to
 * catch if anyone ever "simplifies" the generator back to it.
 */

const T0 = 1_700_000_000_000;

describe("uuidv7", () => {
  it("looks like a UUID and says it is version 7", () => {
    const id = uuidv7(T0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id[14]).toBe("7"); // version nibble — a v4 would have "4" here
    expect("89ab").toContain(id[19]); // variant nibble — top two bits are 10
  });

  it("carries the minute it was minted in its first 48 bits", () => {
    expect(uuidv7Time(uuidv7(T0))).toBe(T0);
    expect(uuidv7Time(uuidv7(0))).toBe(0);
    // Far enough out that a 32-bit implementation would have wrapped. This is the assertion
    // that fails if someone rewrites the timestamp bytes with `>>` instead of division.
    const far = 2 ** 45 + 12345;
    expect(uuidv7Time(uuidv7(far))).toBe(far);
  });

  it("sorts as text in the order it was minted", () => {
    // The whole reason for choosing v7. Shuffle, sort lexicographically, get time order back.
    const times = [T0, T0 + 1, T0 + 1000, T0 + 60_000, T0 + 86_400_000];
    const ids = times.map((t) => uuidv7(t));
    const shuffled = [...ids].reverse();
    expect([...shuffled].sort()).toEqual(ids);
  });

  it("is unique within a millisecond", () => {
    // Two keys minted in the same tick share their first 48 bits, so uniqueness rests
    // entirely on the 74 random ones. A double-clicked Pay button is exactly this case.
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(T0)));
    expect(ids.size).toBe(10_000);
  });

  it("spends every bit it is not claiming on randomness", () => {
    // Feed it all-zero "randomness" and everything except the timestamp, version and variant
    // must be zero. Catches a generator that quietly leaves bytes unfilled.
    const zeroed = uuidv7(T0, (b) => b.fill(0));
    // T0 is 0x018bcfe56800, which is the first twelve hex digits below.
    expect(zeroed).toBe("018bcfe5-6800-7000-8000-000000000000");
    // ...and all-ones, so the masks are proven to clear the bits they claim rather than or-ing
    // into them: version stays 7 and variant stays 10xx even when every random bit is set.
    const ones = uuidv7(T0, (b) => b.fill(0xff));
    expect(ones[14]).toBe("7");
    expect("89ab").toContain(ones[19]);
  });
});
