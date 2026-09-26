import { randomFillSync } from "node:crypto";

/**
 * UUIDv7 — a random identifier with the time it was made buried in the front of it.
 *
 *
 * WHAT A UUID IS, AND WHY THERE ARE VERSIONS
 *
 * A UUID is 128 random-looking bits written as 32 hex characters. The point is that two
 * machines that have never spoken can each invent one and be confident they will not collide,
 * so nobody needs a central counter handing out numbers.
 *
 * The version says where the bits came from. Version 4 — what `crypto.randomUUID()` returns —
 * is 122 bits of pure randomness. Version 7 spends the first 48 of those bits on a plain
 * millisecond timestamp and fills the remaining 74 with randomness.
 *
 *
 * WHY THE TIMESTAMP IS WORTH 48 BITS
 *
 * Because UUIDs sort as text, and v7 sorting as text means sorting by *time*.
 *
 * That sounds cosmetic and is not. Databases keep indexes as sorted trees. Insert v4 keys and
 * every new row lands at a random spot in that tree, so the database is constantly splitting
 * pages in the middle and the "hot" part of the index is the whole index — it stops fitting in
 * memory. Insert v7 keys and every new row lands at the right-hand edge, next to the last one,
 * so the hot part is one page. Same uniqueness guarantee, much friendlier shape.
 *
 * The second payoff is for humans. A v4 key in a log line tells you nothing. A v7 key tells
 * you when it was minted, which means a stray idempotency key in a support ticket can be
 * placed on a timeline without joining against anything.
 *
 * Neither payoff is load-bearing in this prototype, where keys live in a Map that is thrown
 * away on restart. It is here because it costs nothing today and is the kind of decision that
 * is annoying to revisit once identifiers are in a database and in other systems' logs.
 *
 *
 * WHY THIS IS HAND-WRITTEN
 *
 * Node has no v7 generator. `crypto.randomUUID()` is v4 only, and it accepts an options object
 * that silently ignores `{ version: 7 }` rather than refusing it — so the obvious one-liner
 * quietly does the wrong thing and looks right. The `uuid` package has one, but this project
 * has three runtime dependencies and the whole generator is the dozen lines below.
 *
 *
 * THE LAYOUT (RFC 9562, §5.7)
 *
 *   bytes 0-5   48-bit millisecond timestamp, big-endian (most significant byte first)
 *   byte  6     high nibble is the version: 0111 = 7. Low nibble is random.
 *   byte  8     top two bits are the variant: 10. The remaining six are random.
 *   the rest    random
 *
 * The version and variant nibbles are why a UUID is not simply 128 random bits: six of them
 * are spent saying what the other 122 mean.
 */
export function uuidv7(nowMs: number, fill: (b: Uint8Array) => void = randomFillSync): string {
  const bytes = new Uint8Array(16);
  fill(bytes);

  // The 48-bit timestamp, most significant byte first. Written with division rather than `>>`
  // because JavaScript's bitwise operators truncate to 32 bits, and a millisecond timestamp
  // passed 32 bits in 1970 + 49 days. `& 0xff` is safe on the results because it only ever
  // looks at the low eight bits, which survive that truncation intact.
  const ms = Math.floor(nowMs);
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  // Stamp the version and variant over four and two of the random bits respectively. Masking
  // rather than assigning keeps the randomness in the bits we are not claiming.
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx (the "RFC 4122/9562" variant)

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Read back the millisecond timestamp a v7 UUID was minted at. Used by the tests. */
export function uuidv7Time(uuid: string): number {
  return parseInt(uuid.slice(0, 8) + uuid.slice(9, 13), 16);
}
