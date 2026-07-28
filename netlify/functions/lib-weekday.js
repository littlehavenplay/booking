// Shared read helper for the automatic weekday-special discount, so both
// weekday-special.js (the admin GET/POST endpoint) and book.js (which applies
// it at checkout) read from exactly one place.
import { getStore } from "@netlify/blobs";

export const WEEKDAY_SPECIAL_DEFAULT = { enabled: false, days: [], mode: "percent", amount: 0,
  appliesTo: { regular: true, sibling: true, infant: true }, label: "" };

export async function getWeekdaySpecial() {
  try {
    const rec = await getStore("site").get("weekday-special", { type: "json" });
    if (!rec) return WEEKDAY_SPECIAL_DEFAULT;
    return { ...WEEKDAY_SPECIAL_DEFAULT, ...rec, appliesTo: { ...WEEKDAY_SPECIAL_DEFAULT.appliesTo, ...(rec.appliesTo || {}) } };
  } catch { return WEEKDAY_SPECIAL_DEFAULT; }
}
