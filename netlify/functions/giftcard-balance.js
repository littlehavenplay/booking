// GET /api/giftcard-balance?gan=CODE
// Looks up a Square gift card by its code (GAN) and returns the current balance
// and state, so the booking page can show "balance available" before checkout.

import { squareApiBase, SQUARE_VERSION } from "./lib-settings.js";

export default async (req) => {
  const url = new URL(req.url);
  const gan = (url.searchParams.get("gan") || "").trim();
  if (!gan) return json({ ok: false, error: "Enter a gift card code." }, 400);

  const token = process.env.SQUARE_ACCESS_TOKEN;
  if (!token) return json({ ok: false, error: "Gift cards aren't configured yet." }, 500);

  try {
    const res = await fetch(`${squareApiBase()}/v2/gift-cards/from-gan`, {
      method: "POST",
      headers: {
        "Square-Version": SQUARE_VERSION,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ gan }),
    });
    const data = await res.json();
    if (!res.ok || !data.gift_card) {
      return json({ ok: false, error: "That gift card code wasn't found." }, 404);
    }
    const gc = data.gift_card;
    if (gc.state !== "ACTIVE") {
      return json({ ok: false, error: "That gift card isn't active." }, 409);
    }
    return json({
      ok: true,
      balance: gc.balance_money?.amount || 0,   // cents
      state: gc.state,
    });
  } catch (e) {
    return json({ ok: false, error: "Couldn't check that gift card right now." }, 502);
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const config = { path: "/api/giftcard-balance" };
