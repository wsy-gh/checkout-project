import type { Surface } from "@/checkout/types";

/**
 * GROUNDWORK FOR TRANSLATION
 *
 * This app ships in English only. What this file does is remove the things that are painful
 * to retrofit later, so adding a second language stays a content job rather than a rewrite.
 *
 * The expensive problems are never "where do the strings live" — that is a find-and-replace.
 * They are the assumptions about English that get baked into markup:
 *
 *   SENTENCES BUILT BY CONCATENATION. Writing `"starts in " + n + " min"` fixes English word
 *   order into the code. Languages that put the verb last, or the number after the noun,
 *   cannot be expressed by filling in that blank. Whole phrases are therefore written as
 *   whole phrases here — see `copy.ts`, where anything with a value in the middle is a
 *   function taking that value, so a translator can move it.
 *
 *   PLURALS AS `n > 1 ? "s" : ""`. English has two plural forms and picks between them with
 *   a comparison. Japanese has one, Polish has four, Arabic has six, and Russian picks its
 *   form based on the last *two* digits. `plural()` below uses the browser's own rules
 *   instead of a guess.
 *
 *   NUMBERS AND MONEY FORMATTED BY HAND. `$1,234.00` is not how most of the world writes
 *   that. `format.ts` goes through `Intl.NumberFormat`, which already knows.
 *
 * What is deliberately NOT here: the dev-only session inspector, the debug routes, and
 * anything under `src/checkout/`. None of it is fan-facing, and translating it would be
 * effort spent on an audience of one.
 *
 * The actual next step, when a second language is wanted: this constant becomes a value read
 * from the request, `copy.ts` grows a layer keyed by locale, and the components stay exactly
 * as they are.
 */
export const LOCALE = "en-US";

const pluralRules = new Intl.PluralRules(LOCALE);

/**
 * Pick the right wording for a count.
 *
 * `plural(1, { one: "ticket", other: "tickets" })` → "ticket". The category names are the
 * ones the Intl standard uses, so a language needing `few` or `many` adds them to the object
 * and nothing else changes. English only ever returns `one` or `other`.
 */
export function plural(count: number, forms: Partial<Record<Intl.LDMLPluralRule, string>>): string {
  return forms[pluralRules.select(count)] ?? forms.other ?? "";
}

/**
 * A phrase that reads differently on the two surfaces.
 *
 * The phone says less, because it has less room and a fan on a phone is usually mid-task.
 * Both versions are full sentences rather than fragments assembled at the call site, which
 * is what keeps them translatable.
 */
export type Wording = Record<Surface, string>;

/** For the many phrases that are the same on both surfaces. */
export const same = (text: string): Wording => ({ web: text, mobile: text });
