// Shared configuration used by the serverless functions.
// Prices are defined HERE (server-side) so they can never be tampered with
// from the browser. Override any of these with environment variables in Netlify.

export const CAPACITY = parseInt(process.env.CAPACITY || "13", 10);

// How many days ahead open play can be booked (rolling window). Default 2 weeks.
export const BOOKING_WINDOW_DAYS = parseInt(process.env.BOOKING_WINDOW_DAYS || "14", 10);

// ---- Scheduled price change ----
// New prices take effect at 12:00 AM Pacific on this date (based on checkout date).
// Anything bought before this date is charged the old price.
// New pricing goes live 12:00 AM Pacific on 2026-07-02. Bookings/checkouts before
// that date keep the prior prices; on/after that date the new prices apply.
// (Same mechanism that handled the 6/12 change.)
export const PRICE_CHANGE_DATE = process.env.PRICE_CHANGE_DATE || "2026-01-01"; // change is LIVE — new pricing applies unconditionally
export function pacificToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD
}

// PRICES_OLD = the prices in effect right up to the change date (the current live
// prices), so uploading early never changes anything before 7/2.
const PRICES_OLD = {
  regular: parseInt(process.env.PRICE_REGULAR_CENTS || "1900", 10), // $19.00 (prior)
  sibling: parseInt(process.env.PRICE_SIBLING_CENTS || "1500", 10), // $15.00 (prior)
  infant:  parseInt(process.env.PRICE_INFANT_CENTS  || "1300", 10), // $13.00 (prior)
};
// PRICES_NEW = the new pricing effective 7/2. Toddler & Baby each INCLUDE 2 adults.
const PRICES_NEW = {
  regular: parseInt(process.env.PRICE_REGULAR_NEW_CENTS || "2300", 10), // $23.00
  sibling: parseInt(process.env.PRICE_SIBLING_NEW_CENTS || "1900", 10), // $19.00
  infant:  parseInt(process.env.PRICE_INFANT_NEW_CENTS  || "1700", 10), // $17.00
};
// Prices for a given checkout date (defaults to today, Pacific).
export function pricesFor(dateStr) {
  return (dateStr || pacificToday()) >= PRICE_CHANGE_DATE ? PRICES_NEW : PRICES_OLD;
}

// ---- Adults included / additional-adult rule (date-gated with the price change) ----
// BEFORE 7/2: 1 adult included per child admission (any type), $7 per additional adult.
// ON/AFTER 7/2: 2 adults included per Regular or Baby/Infant admission — every one of
// those admissions carries its own 2 adults, so 2 Regular admissions include 4 adults.
// The Sibling add-on carries no adults of its own and does not count toward this.
// $5 per adult beyond the included total.
export function adultRuleFor(dateStr) {
  const useNew = (dateStr || pacificToday()) >= PRICE_CHANGE_DATE;
  return useNew
    ? { includedPerChild: 2, sibExempt: true, extraCents: 500 }
    : { includedPerChild: 1, sibExempt: false, extraCents: 700 };
}
// Number of PAID (extra) adults for a booking on a given checkout date.
//   eligibleChildren = admissions that carry included adults (Regular + Baby/Infant)
//   allChildren      = every admission, including Sibling add-on (used pre-7/2 only)
export function additionalAdultsFor(dateStr, totalAdults, eligibleChildren, allChildren) {
  const r = adultRuleFor(dateStr);
  const ta = Math.max(0, parseInt(totalAdults, 10) || 0);
  const kids = r.sibExempt
    ? Math.max(0, parseInt(eligibleChildren, 10) || 0)
    : Math.max(0, parseInt(allChildren ?? eligibleChildren, 10) || 0);
  const included = r.includedPerChild * kids;
  return Math.max(0, ta - included);
}
export function additionalAdultCentsFor(dateStr) {
  return adultRuleFor(dateStr).extraCents;
}
// Legacy export (today's prices) — request-time code should call pricesFor().
export const PRICES = pricesFor();

export const STUDIO_NAME = process.env.STUDIO_NAME || "Little Haven Play Studio";

// Sales tax rate applied on top of the subtotal (e.g. 0.0875 = 8.75%)
export const TAX_RATE = parseFloat(process.env.TAX_RATE || "0.0875");

// Dates the studio is closed (no bookings). Comma-separated YYYY-MM-DD in the
// CLOSED_DATES env var, e.g. "2026-06-01,2026-06-02". Edit in Netlify anytime.
export const CLOSED_DATES = (process.env.CLOSED_DATES || "2026-06-01,2026-06-02")
  .split(",").map(s => s.trim()).filter(Boolean);
export const CLOSED_MESSAGE = process.env.CLOSED_MESSAGE || "Temporarily closed for improvements";

// ---- Punch cards (punch cards) ----
// Tracked by us (visit counts); purchase is a normal Square payment (money in).
// Prices below are the CURRENT (pre-6/12) prices; new prices apply from PRICE_CHANGE_DATE.
// Punch cards. NEW model (sold from 7/2): buy 7 visits, your 8th visit is FREE
// (8 visits total for the price of 7). Toddler & Baby cards include 2 adults per
// visit; the Sibling add-on card carries no adults of its own and can only be
// redeemed alongside a paid/carded Toddler admission (open play only).
//   Regular : 7 × $23 = $161   (16100)
//   Sibling : 7 × $19 = $133   (13300)
//   Baby    : 7 × $17 = $119   (11900)
// OLD cards (R10/R5/I10/I5) are RETIRED FROM SALE but stay here so existing
// holders can still redeem their remaining visits at their original terms — they
// are flagged legacy + retired so the storefront never offers them again.
export const PASSES = {
  // ---- All prepaid cards are RETIRED FROM SALE (replaced by the loyalty punch
  // card). Existing holders keep redeeming remaining visits + free coffee until
  // empty, then roll into the loyalty program. Nothing here is sellable anymore. ----
  R8: { label: "Toddler Punch Card — 8 Visits (Legacy)", admission: "regular", visits: 8, paidVisits: 7, price: 16100, img: "punch-card-hero.png", typeNum: 5, expiryMonths: 12, adultsIncluded: 2, freeCoffee: true, sellable: false, legacy: true },
  S8: { label: "Sibling Add-On Punch Card — 8 Visits (Legacy)", admission: "sibling", visits: 8, paidVisits: 7, price: 13300, img: "punch-card-hero.png", typeNum: 6, expiryMonths: 12, adultsIncluded: 0, freeCoffee: true, sellable: false, legacy: true, requiresRegular: true, openPlayOnly: true },
  I8: { label: "Baby / Infant Punch Card — 8 Visits (Legacy)", admission: "infant", visits: 8, paidVisits: 7, price: 11900, img: "punch-card-hero.png", typeNum: 7, expiryMonths: 12, adultsIncluded: 2, freeCoffee: true, sellable: false, legacy: true },
  R10: { label: "Regular 10-Visit Punch Card (Legacy)", admission: "regular", visits: 10, price: 15200, img: "pass-regular-10.png", typeNum: 1, expiryMonths: 12, legacy: true, sellable: false },
  R5:  { label: "Regular 5-Visit Punch Card (Legacy)",  admission: "regular", visits: 5,  price: 8000,  img: "pass-regular-5.png",  typeNum: 2, expiryMonths: 12, legacy: true, sellable: false },
  I10: { label: "Baby/Infant 10-Visit Punch Card (Legacy)", admission: "infant", visits: 10, price: 10400, img: "pass-infant-10.png", typeNum: 3, expiryMonths: 12, legacy: true, sellable: false },
  I5:  { label: "Baby/Infant 5-Visit Punch Card (Legacy)",  admission: "infant", visits: 5,  price: 5500,  img: "pass-infant-5.png",  typeNum: 4, expiryMonths: 12, legacy: true, sellable: false },
};
// Brand-new cards have a single price (no old/new split). Legacy cards keep theirs.
const PASS_PRICES_NEW = {};
// Returns the PASSES map with prices for a given checkout date (defaults to today).
export function passesFor(dateStr) {
  const useNew = (dateStr || pacificToday()) >= PRICE_CHANGE_DATE;
  const out = {};
  for (const [id, p] of Object.entries(PASSES)) {
    out[id] = { ...p, price: useNew ? (PASS_PRICES_NEW[id] ?? p.price) : p.price };
  }
  return out;
}
// Only the cards a NEW customer may buy (drives the storefront list).
export function sellablePasses(dateStr) {
  const all = passesFor(dateStr);
  const out = {};
  for (const [id, p] of Object.entries(all)) if (p.sellable) out[id] = p;
  return out;
}
export function isLegacyPass(id) { return !!(PASSES[id] && PASSES[id].legacy); }

// Computes a punch card's expiry date SAFELY. Standard cards expire `expiryMonths`
// (default 12) from `base`. Infant cards may expire earlier — at the child's
// 18-month birthday — BUT only if that date is still in the future; a child who
// has already aged out must not receive an already-expired card. The result is
// guaranteed to be after `base` (never a past/same-day expiry).
export function passExpiryDate(base, expiryMonths, admission, dobMonth, dobYear) {
  const now = base instanceof Date ? base : new Date();
  const twelveMo = new Date(now); twelveMo.setMonth(twelveMo.getMonth() + (parseInt(expiryMonths, 10) || 12));
  let expiry = twelveMo;
  const dm = parseInt(dobMonth, 10), dy = parseInt(dobYear, 10);
  if (admission === "infant" && dm >= 1 && dm <= 12 && dy > 1900) {
    const eighteenMo = new Date(dy, (dm - 1) + 18, 1);
    // Only cap to the 18-month birthday if it's still in the future AND sooner
    // than the standard 12-month expiry. Never cap to a past date.
    if (eighteenMo > now && eighteenMo < twelveMo) expiry = eighteenMo;
  }
  if (expiry <= now) expiry = twelveMo;   // absolute floor — never born expired
  return expiry;
}

// Flat fallback (used only by older code paths). Live rule is additionalAdultCentsFor(date).
export const ADDITIONAL_ADULT = parseInt(process.env.ADDITIONAL_ADULT_CENTS || "500", 10); // $5

export const PASS_POLICY_TITLE = "Little Haven Punch Card Policy";
export const PASS_POLICY_LINES = [
  "Every punch card is 8 visits for the price of 7 — pay for 7 visits and your 8th visit is free.",
  "Toddler and Baby/Infant punch cards include admission for 2 adults per visit. Additional adults are $5 per person, per visit.",
  "The Sibling Add-On punch card does not include any adults of its own and may only be used on the same visit as a paid or carded Toddler admission. It cannot be redeemed on its own.",
  "Sibling Add-On punch cards are valid for Open Play Sessions only.",
  "Free coffee from our self-serve station is included for punch card holders on each visit.",
  "Visits are tracked digitally. Use your punch card code at checkout to redeem a visit.",
  "When your card is used up, that prepaid product is no longer available — you're automatically moved to our free Loyalty Punch Card program, where every 8th visit is free with no purchase needed.",
  "Punch cards are valid for Open Play Sessions only.",
  "Legacy prepaid punch cards are no longer sold — this policy applies only to existing prepaid cards still being used down. New families join our free Loyalty Punch Card program automatically.",
  "A valid punch card code must be entered at checkout when reserving a play session.",
  "Reservations are subject to availability and capacity limits.",
  "Punch cards are non-refundable, non-transferable, and have no cash value.",
  "Punch cards may not be sold, shared, exchanged, or transferred to another child or family.",
  "Punch cards cannot be combined with other discounts, promotions, coupons, or special offers unless otherwise stated.",
  "Lost, stolen, unused, or expired visits will not be replaced or refunded.",
  "Little Haven reserves the right to modify policies, hours, admission pricing, and operating procedures at any time.",
  "Each punch card is valid for one child only and may not be shared between siblings or other guests.",
  "Punch cards are valid only for the admission type purchased. Visits cannot be split between multiple children.",
  "All adults and children entering Little Haven must have a completed waiver on file prior to entry.",
  "Baby/Infant Punch Cards are valid only for children ages 6–17 months and expire on the child's 18-month birthday or 12 months from purchase, whichever occurs first.",
  "Any unused baby/infant visits after a child turns 18 months may be used by paying the difference between the Baby/Infant and current Toddler Admission rate at each visit. No refunds for unused baby/infant visits.",
  "Toddler and Sibling Punch Cards expire 12 months from the purchase date.",
  "Punch cards purchased before an admission price change keep their full remaining visits at no additional charge — a price change never requires topping up an existing card.",
  "Reservations are subject to Little Haven's current cancellation policy. No-shows may result in the loss of that visit credit.",
];

export const POLICY_TITLE = "Open Play Booking Cancellation & Refund Policy";
export const POLICY_LINES = [
  "Open Play bookings are prepaid. We understand things come up, especially with little ones!",
  "If you're unable to attend your booked session, please email us at hello@littlehavenplay.com and we'll do our best to accommodate you and issue a store credit toward a future visit (typically valid for 30 days).",
  "Open play admission is valid only for the selected date and time booked.",
  "If you do not show up within one hour of your reserved time, we will automatically issue a courtesy store credit for the full amount paid to the email on file, valid for 15 days from issuance, so you can reschedule whenever works for you.",
  `If ${STUDIO_NAME} needs to cancel or close unexpectedly, guests will be offered the option to reschedule or receive store credit.`,
  "Military discounts and other in-person discounts cannot be applied to online bookings after purchase.",
  "For any questions or concerns, please contact us at hello@littlehavenplay.com and we will respond within 24 hours.",
];

// ---- LEGACY 2-hour sessions ----
// Kept ONLY so existing reservations (and dates already booked under the old
// scheme) keep showing and counting. New customers are never offered these.
export const OPENPLAY = {
  "9-11":    { label: "9:00 - 11:00 AM",    start: 540, end: 660, cap: CAPACITY },
  "11-1":    { label: "11:00 AM - 1:00 PM", start: 660, end: 780, cap: CAPACITY },
  "1-3":     { label: "1:00 - 3:00 PM",     start: 780, end: 900, cap: CAPACITY },
  "2-4":     { label: "2:00 - 4:00 PM",     start: 840, end: 960, cap: 5, days: [5, 6] },
  "12-2":    { label: "12:00 - 2:00 PM",    start: 720, end: 840, cap: CAPACITY, partyDay: true },
  "230-430": { label: "2:30 - 4:30 PM",     start: 870, end: 990, cap: CAPACITY, partyDay: true },
};
export const LEGACY_SLOT_IDS = Object.keys(OPENPLAY);

// ---- NEW arrival times (the bookable unit going forward) ----
// Customers pick when they'll ARRIVE; a visit lasts VISIT_MINUTES (2 hours).
export const VISIT_MINUTES = 120;
export const ARRIVAL_CAP = parseInt(process.env.ARRIVAL_CAP || "6", 10); // children per arrival time
export const ARRIVAL = {
  "arr09": { label: "9:00 AM",  start: 540 },
  "arr10": { label: "10:00 AM", start: 600 },
  "arr11": { label: "11:00 AM", start: 660 },
  "arr12": { label: "12:00 PM", start: 720 },
  "arr13": { label: "1:00 PM",  start: 780 },
  "arr14": { label: "2:00 PM",  start: 840 },
  "arr15": { label: "3:00 PM",  start: 900 },  // last call on Fri/Sat (4pm close)
  "arr16": { label: "4:00 PM",  start: 960 },  // only via seasonal extended hours
  "arr17": { label: "5:00 PM",  start: 1020 },
  "arr18": { label: "6:00 PM",  start: 1080 },
};
export const ARRIVAL_IDS = Object.keys(ARRIVAL);

// Each old session now counts as the arrival time that begins at the same hour.
export const LEGACY_TO_ARRIVAL = {
  "9-11": "arr09", "11-1": "arr11", "1-3": "arr13",
  "2-4": "arr14", "12-2": "arr12", "230-430": "arr14",
};
// Reverse map: legacy slot keys whose children feed each arrival slot.
export const ARRIVAL_TO_LEGACY = ARRIVAL_IDS.reduce((m, a) => {
  m[a] = Object.keys(LEGACY_TO_ARRIVAL).filter(l => LEGACY_TO_ARRIVAL[l] === a);
  return m;
}, {});

// SLOTS / SLOT_IDS now describe the arrival times (what NEW bookings use).
export const SLOTS = ARRIVAL_IDS.map(id => ({ id, label: ARRIVAL[id].label, cap: ARRIVAL_CAP }));
export const SLOT_IDS = ARRIVAL_IDS;
// For scanning stored bookings we must look at BOTH arrival and legacy keys.
export const ALL_SLOT_IDS = [...ARRIVAL_IDS, ...LEGACY_SLOT_IDS];

export function slotLabel(id) {
  if (ARRIVAL[id]) return ARRIVAL[id].label;
  if (OPENPLAY[id]) return OPENPLAY[id].label;
  return id;
}
export function arrivalStartMin(slotId) {
  return ARRIVAL[slotId] ? ARRIVAL[slotId].start : null;
}

export function slotCap(slotId) {
  return ARRIVAL[slotId] ? ARRIVAL_CAP : ((OPENPLAY[slotId] && OPENPLAY[slotId].cap) || ARRIVAL_CAP);
}

// Closing time per day (minutes from midnight). Last admission is 1 hour before.
export function closeMinutes(date) {
  const wd = new Date(date + "T00:00:00Z").getUTCDay();
  return (wd === 5 || wd === 6) ? 960 : 900;   // 4:00 PM Fri/Sat, 3:00 PM otherwise
}

// Recurring weekly closures fallback (0=Sun ... 3=Wed ... 6=Sat). Used only when
// no Weekly schedule has been saved in admin/staff. Closed Wednesday by default.
export const CLOSED_WEEKDAYS = (process.env.CLOSED_WEEKDAYS || "3")
  .split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n >= 0 && n <= 6);
export function weekdayOf(date) { return new Date(date + "T00:00:00Z").getUTCDay(); }
export function fmtClock(min) {
  let h = Math.floor(min / 60), m = min % 60, ap = h >= 12 ? "PM" : "AM", hh = h % 12; if (hh === 0) hh = 12;
  return hh + ":" + String(m).padStart(2, "0") + " " + ap;
}

// Built-in fallback hours for a date (open 9:00; close 3:00, 4:00 Fri/Sat; Wed closed).
function defaultDay(date) {
  return { open: 540, close: closeMinutes(date), closed: CLOSED_WEEKDAYS.includes(weekdayOf(date)) };
}
// Read & validate one weekday's entry from a saved schedule {0..6:{open,close,closed}}.
function pickDay(sched, wd) {
  if (!sched || typeof sched !== "object") return null;
  const d = sched[wd] != null ? sched[wd] : sched[String(wd)];
  if (!d) return null;
  if (d.closed) return { open: 540, close: 900, closed: true };
  const open = Number(d.open), close = Number(d.close);
  if (!Number.isFinite(open) || !Number.isFinite(close) || close <= open) return null;
  return { open, close, closed: false };
}

// Effective hours for a date. Priority: active Seasonal window's per-day schedule
// > Weekly schedule > built-in defaults. Returns {open, close, closed, seasonal, label}.
export function hoursFor(date, seasonal, weekly) {
  const wd = weekdayOf(date);
  if (seasonal && seasonal.active && seasonal.from && seasonal.to && date >= seasonal.from && date <= seasonal.to) {
    const sd = pickDay(seasonal.schedule, wd);
    if (sd) return { ...sd, seasonal: true, label: seasonal.label || "Seasonal hours" };
    // legacy single-time seasonal (pre per-day): same time every day
    if (Number.isFinite(seasonal.open) && Number.isFinite(seasonal.close) && seasonal.close > seasonal.open) {
      const closed = defaultDay(date).closed && !seasonal.openWednesdays;
      return { open: seasonal.open, close: seasonal.close, closed, seasonal: true, label: seasonal.label || "Seasonal hours" };
    }
  }
  const wk = pickDay(weekly, wd);
  if (wk) return { ...wk, seasonal: false, label: "" };
  return { ...defaultDay(date), seasonal: false, label: "" };
}

// Back-compat helper: is this date closed? (resolves through weekly + seasonal)
export function isClosedWeekday(date, seasonal, weekly) {
  return !!hoursFor(date, seasonal, weekly).closed;
}

// Which arrival times are bookable on a date: arrivals must be within open hours
// and at least 1 hour before close; any whose 2-hour visit runs into closing is
// flagged as a ~1-hour "last hour" visit. Drops arrivals overlapping a party.
export function openPlayForDate(date, bookedPartyIds = [], hours = null) {
  const h = hours || defaultDay(date);
  if (h.closed) return [];                                  // closed that day
  const open = h.open, close = h.close;
  const windows = bookedPartyIds
    .map(id => PARTY_SLOTS.find(p => p.id === id))
    .filter(Boolean)
    .map(p => [p.start - PARTY_BUFFER, p.end + PARTY_BUFFER]);
  return ARRIVAL_IDS
    .filter(id => {
      const a = ARRIVAL[id];
      if (a.start < open) return false;                       // before we open
      if (a.start > close - 60) return false;                 // last admission = close − 1hr
      const vEnd = Math.min(a.start + VISIT_MINUTES, close);
      return !windows.some(w => a.start < w[1] && vEnd > w[0]); // visit overlaps a party
    })
    .map(id => {
      const a = ARRIVAL[id];
      const vEnd = Math.min(a.start + VISIT_MINUTES, close);
      const lastCall = (vEnd - a.start) < VISIT_MINUTES;
      return {
        id,
        label: a.label + (lastCall ? " (last hour)" : ""),
        note: lastCall ? `We close at ${fmtClock(close)} — about a 1-hour visit. Come on by if an hour works for you!` : "",
        lastCall,
      };
    });
}

// ---- Private party config ----
export const PARTY_DAYS = [5, 6, 0];           // Fri, Sat, Sun
export const PARTY_BUFFER = 30;                // 30-min clean/prep buffer each side
export const PARTY_BOOKING_MIN_DAYS = 14;      // must book at least 2 weeks ahead
export const PARTY_CHILD_CAP = parseInt(process.env.PARTY_CHILD_CAP || "15", 10); // private parties stay at 15
export const PARTY_SLOTS = [
  { id: "p0930", label: "9:30 - 11:30 AM", start: 570,  end: 690 },
  { id: "p1200", label: "12:00 - 2:00 PM", start: 720,  end: 840 },
  { id: "p1430", label: "2:30 - 4:30 PM",  start: 870,  end: 990 },
  { id: "p1700", label: "5:00 - 7:00 PM",  start: 1020, end: 1140 },
];
export const PARTY_SLOT_IDS = PARTY_SLOTS.map(s => s.id);
// Per-package overage pricing (cents): charged at end of party for guests over the included counts.
export const PARTY_EXTRA_CHILD = 2500;  // $25 per additional child
export const PARTY_EXTRA_ADULT = 1500;  // $15 per additional adult

export const PARTY_PACKAGES = {
  sweet: { label: "Sweet Party", deposit: 10000, price: 42900, kidsIncl: 10, adultsIncl: 8, totalGuests: 18, link: "https://square.link/u/pxxRlwWf" },
  haven: { label: "Haven Party", deposit: 15000, price: 54900, kidsIncl: 13, adultsIncl: 7, totalGuests: 20, link: "https://square.link/u/aCag3AZt" },
  dream: { label: "Dream Party", deposit: 20000, price: 69900, kidsIncl: 15, adultsIncl: 10, totalGuests: 25, link: "https://square.link/u/81A4S8Ty" },
};

// Per-guest overage pricing for parties (cents).
export const ADDITIONAL_CHILD_PRICE = 2500;  // $25 per child over the package's included kids
export const ADDITIONAL_ADULT_PRICE = 1500;  // $15 per adult over the package's included adults

// Post-deposit preferences questionnaire, per package (rendered as labeled dropdowns/inputs).
export const PARTY_QUESTIONNAIRE = {
  sweet: [
    { id: "tablecloth", label: "Tablecloth color", type: "select", options: ["Black", "White"] },
  ],
  haven: [
    { id: "tablecloth", label: "Tablecloth color", type: "select", options: ["Black", "White"] },
    { id: "pizza1", label: "Pizza #1 topping", type: "select", options: ["Cheese", "Pepperoni"] },
    { id: "pizza2", label: "Pizza #2 topping", type: "select", options: ["Cheese", "Pepperoni"] },
    { id: "balloons", label: "Balloon colors (themed to your party)", type: "text" },
  ],
  dream: [
    { id: "tablecloth", label: "Tablecloth color", type: "select", options: ["Black", "White"] },
    { id: "pizza1", label: "Pizza #1 topping", type: "select", options: ["Cheese", "Pepperoni"] },
    { id: "pizza2", label: "Pizza #2 topping", type: "select", options: ["Cheese", "Pepperoni"] },
    { id: "pizza3", label: "Pizza #3 topping", type: "select", options: ["Cheese", "Pepperoni"] },
    { id: "balloons", label: "Balloon colors — choose up to 3", type: "text" },
    { id: "mascot", label: "Mascot appearance (based on availability)", type: "select", options: ["Bluey", "Chase (Paw Patrol)", "Minty the Bunny", "No mascot, thanks"] },
  ],
};
// Asked for every package, after the package-specific questions.
export const PARTY_QUESTIONNAIRE_COMMON = [
  { id: "theme", label: "Party theme (e.g. Paw Patrol, Hello Kitty, sage & brown)", type: "text" },
  { id: "comments", label: "Comments, questions, or add-on requests", type: "textarea" },
];

// Waiver link (forwarded to party hosts and reminded before arrival).
export const WAIVER_URL = "https://waivermaster.com/sign.html?q=DU3F7C23VNX8D";

export function isPartyDay(date) {
  return PARTY_DAYS.includes(new Date(date + "T00:00:00Z").getUTCDay());
}

// Party-priority windows: on party days, prime party time-blocks stay party-only
// (hidden from open-play booking) until PARTY_PRIORITY_DAYS before the date. If no
// party books them by then, they auto-open to open play. Booked parties always block.
export const PARTY_PRIORITY_DAYS = 7;
export function effectivePartyBlocks(date, bookedPartyIds = []) {
  const set = new Set(bookedPartyIds);
  if (isPartyDay(date)) {
    const daysOut = Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(pacificToday() + "T00:00:00Z")) / 86400000);
    if (daysOut > PARTY_PRIORITY_DAYS) for (const id of PARTY_SLOT_IDS) set.add(id);
  }
  return [...set];
}

export function squareApiBase() {
  return (process.env.SQUARE_ENVIRONMENT || "sandbox") === "production"
    ? "https://connect.squareup.com"
    : "https://connect.squareupsandbox.com";
}

export const SQUARE_VERSION = "2026-01-22";

// Storage key for a given date + slot, e.g. "2026-05-30__9-11"
export function slotKey(date, slot) {
  return `${date}__${slot}`;
}
