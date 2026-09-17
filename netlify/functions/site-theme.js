// GET  /api/site-theme   -> { ok, theme, label, css }   (public, used by every page)
// POST /api/site-theme   -> set the theme                (admin key or staff PIN)
//
// Colour only. This endpoint returns a block of CSS custom-property overrides
// and nothing else — no markup, no behaviour, no pricing. The worst a bad theme
// can do is look wrong, and switching back to "default" undoes it instantly.
//
// Every override keeps the original colour's lightness and changes only its hue,
// so text contrast is identical in every theme. Third-party brand colours (Yelp,
// Google, Facebook) are excluded from theming entirely.

import { getStore } from "@netlify/blobs";
import { THEMES } from "./lib-theme.js";

const json = (o, s = 200, extra = {}) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { "content-type": "application/json", ...extra },
  });

const KEY = "site:theme";

async function current() {
  try {
    const rec = await getStore("settings").get(KEY, { type: "json" });
    const t = rec && rec.theme;
    if (t && THEMES.themes[t]) return t;
  } catch {}
  return "default";
}

export default async (req) => {
  if (req.method === "GET") {
    const theme = await current();
    return json(
      { ok: true, theme, label: THEMES.themes[theme].label, css: THEMES.css[theme] || "" },
      200,
      // Short cache: a theme change should show up quickly, but every page load
      // hits this so it shouldn't be uncached either.
      { "cache-control": "public, max-age=120" }
    );
  }

  if (req.method !== "POST") return json({ error: "Use GET or POST." }, 405);

  let b; try { b = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }

  const adminKey = process.env.ADMIN_KEY || "", staffPin = process.env.STAFF_PIN || "";
  const provided = (b.key || "").toString();
  if (!adminKey && !staffPin) return json({ error: "Admin key isn't configured." }, 500);
  if (provided !== adminKey && provided !== staffPin) return json({ error: "Wrong key." }, 401);

  if (b.action === "list") {
    return json({ ok: true, theme: await current(), themes: THEMES.themes });
  }

  const theme = (b.theme || "").toString();
  if (!THEMES.themes[theme]) return json({ error: "That isn't one of the themes." }, 400);

  try {
    await getStore("settings").setJSON(KEY, {
      theme, setAt: new Date().toISOString(), setBy: provided === adminKey ? "admin" : "staff",
    });
  } catch (e) {
    return json({ error: "Couldn't save the theme. Try again." }, 502);
  }

  return json({
    ok: true, theme, label: THEMES.themes[theme].label,
    message: `Site theme set to ${THEMES.themes[theme].label}. Visitors see it within a couple of minutes, or straight away on a hard refresh.`,
  });
};

export const config = { path: "/api/site-theme" };
