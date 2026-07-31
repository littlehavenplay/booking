// GET /api/config
// Returns only PUBLIC-safe values for the browser to initialize the Square
// card form and render prices/slots. The secret access token is never sent here.

import { CAPACITY, ARRIVAL_CAP, PRICES, pricesFor, SLOTS, STUDIO_NAME, POLICY_TITLE, POLICY_LINES, CLOSED_DATES, CLOSED_MESSAGE, PASSES, passesFor, sellablePasses, ADDITIONAL_ADULT, additionalAdultCentsFor, adultRuleFor, PASS_POLICY_TITLE, PASS_POLICY_LINES, BOOKING_WINDOW_DAYS, PARTY_PACKAGES, PARTY_SLOTS, PARTY_DAYS, PARTY_BOOKING_MIN_DAYS } from "./lib-settings.js";
import { getWeekdaySpecial } from "./lib-weekday.js";

export default async () => {
  const prices = pricesFor();              // today's effective session prices
  const passSrc = sellablePasses();        // only the cards a new customer can buy
  const aRule = adultRuleFor();            // today's effective included-adults rule
  const weekdaySpecial = await getWeekdaySpecial();
  // Public-safe pass list for the purchase page
  const passes = Object.entries(passSrc).map(([id, p]) => ({
    id, label: p.label, admission: p.admission, visits: p.visits, price: p.price, img: p.img,
    adultsIncluded: p.adultsIncluded || 0, freeCoffee: !!p.freeCoffee,
    requiresRegular: !!p.requiresRegular, openPlayOnly: !!p.openPlayOnly,
  }));
  const body = {
    applicationId: process.env.SQUARE_APPLICATION_ID || "",
    locationId: process.env.SQUARE_LOCATION_ID || "",
    environment: process.env.SQUARE_ENVIRONMENT || "sandbox",
    capacity: ARRIVAL_CAP,
    bookingWindowDays: BOOKING_WINDOW_DAYS,
    prices: prices,
    closedDates: CLOSED_DATES,
    closedMessage: CLOSED_MESSAGE,
    passes,
    additionalAdult: additionalAdultCentsFor(),
    adultsIncludedPerChild: aRule.includedPerChild || 0,
    adultsSiblingExempt: !!aRule.sibExempt,
    weekdaySpecial,
    giftCardUrl: process.env.GIFTCARD_URL || "https://app.squareup.com/gift/ML19A12KYC832/order",
    passPolicyTitle: PASS_POLICY_TITLE,
    passPolicyLines: PASS_POLICY_LINES,
    slots: SLOTS,
    studioName: STUDIO_NAME,
    policyTitle: POLICY_TITLE,
    policyLines: POLICY_LINES,
    partyPackages: Object.entries(PARTY_PACKAGES).map(([id,p])=>({id,label:p.label,deposit:p.deposit})),
    partySlots: PARTY_SLOTS.map(s=>({id:s.id,label:s.label})),
    partyDays: PARTY_DAYS,
    partyMinDays: PARTY_BOOKING_MIN_DAYS,
    configured: Boolean(process.env.SQUARE_APPLICATION_ID && process.env.SQUARE_LOCATION_ID),
  };
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
};

export const config = { path: "/api/config" };
