/* Little Haven Play Studio — Tawk.to live chat loader.

   Loaded on customer-facing pages only. Deliberately NOT on admin.html,
   staff.html, headcount.html or loyalty.html — a chat bubble has no place on the dashboards
   used at the front desk during check-in.

   To change the chat account later, edit TAWK_SRC below and nothing else.
*/
(function () {
  "use strict";

  var TAWK_SRC = "https://embed.tawk.to/6a8318e864b484344ea62d46/default";

  // Don't load on internal dashboards even if this file is included by mistake.
  var page = (location.pathname.split("/").pop() || "index.html").toLowerCase();
  if (["admin.html", "staff.html", "headcount.html", "loyalty.html"].indexOf(page) > -1) return;

  window.Tawk_API = window.Tawk_API || {};
  window.Tawk_LoadStart = new Date();

  // Sit above ordinary page content but below full-screen overlays (lightboxes
  // and checkout modals), so the bubble never floats on top of a payment sheet.
  window.Tawk_API.customStyle = { zIndex: 1000 };

  var s = document.createElement("script");
  s.async = true;
  s.src = TAWK_SRC;
  s.charset = "UTF-8";
  s.setAttribute("crossorigin", "*");
  var first = document.getElementsByTagName("script")[0];
  if (first && first.parentNode) first.parentNode.insertBefore(s, first);
  else document.head.appendChild(s);
})();
