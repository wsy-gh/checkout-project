import { describe, expect, it } from "vitest";
import { duration, money } from "@/lib/format";

// Money is integer cents everywhere; this is the one place it becomes a string.
describe("money", () => {
  it("formats cents with a separator and exactly two decimals", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(8900)).toBe("$89.00");
    expect(money(1)).toBe("$0.01");
    expect(money(123400)).toBe("$1,234.00"); // toFixed(2) gave "$1234.00"
    expect(money(-2500)).toBe("-$25.00");
  });

  it("is exact for every amount an order can produce", () => {
    // The only division in the app. Brute-force it rather than assume IEEE-754 behaves.
    for (let cents = 0; cents <= 2_000_000; cents++) {
      const expected = `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
      if (money(cents).replace(/[$,]/g, "") !== expected) {
        throw new Error(`money(${cents}) = ${money(cents)}, expected $${expected}`);
      }
    }
  });

  it("does not vary with the runtime locale, so SSR and the browser agree", () => {
    const original = process.env.LANG;
    process.env.LANG = "de_DE.UTF-8";
    expect(money(123400)).toBe("$1,234.00");
    process.env.LANG = original;
  });
});

describe("duration", () => {
  it("gets coarser as the number gets bigger", () => {
    expect(duration(0)).toBe("0s");
    expect(duration(45_000)).toBe("45s");
    expect(duration(59_999)).toBe("1 min"); // rounds to the nearest second first
    expect(duration(60_000)).toBe("1 min");
    expect(duration(25 * 60_000)).toBe("25 min");
    expect(duration(60 * 60_000)).toBe("1h"); // not "1h 0m"
    expect(duration(90 * 60_000)).toBe("1h 30m");
    expect(duration(6 * 60 * 60_000)).toBe("6h");
  });

  it("never renders a negative duration", () => {
    expect(duration(-5_000)).toBe("0s");
  });
});
