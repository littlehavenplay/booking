/*
 * phone-format.js — Little Haven Play Studio
 * -------------------------------------------------------------
 * Auto-formats any phone field on the whole site (customer + staff
 * admin) into  AREA-PREFIX-LINE  ->  714-717-9143.
 *
 * Accepts ANY way a number is typed or pasted:
 *   7147179143   714.717.9143   (714) 717-9143   +1 714 717 9143
 *   1-714-717-9143   714/717/9143  ... all become  714-717-9143
 *
 * Rules:
 *   - Strips everything that isn't a digit.
 *   - If 11 digits starting with 1 (US country code), the 1 is dropped.
 *   - First 3 digits = area code, next 3 = prefix, last 4 = line number.
 *   - Dashes are inserted automatically as they type or on paste.
 *
 * Safe by design:
 *   - Only touches <input type="tel">.
 *   - SKIPS short fields (maxlength under 12) so the loyalty
 *     "family phone (last 4)" box is never reformatted.
 *   - SKIPS any field marked  data-no-phone-format.
 *   - Watches for fields added later (loyalty rows, pop-ups, etc.).
 *
 * The backend always reads phone numbers as digits only, so the
 * dashes are purely cosmetic and never affect lookups or codes.
 */
(function () {
  "use strict";

  function formatPhone(raw) {
    var d = String(raw == null ? "" : raw).replace(/\D/g, "");
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1); // drop US country code
    d = d.slice(0, 10);
    if (d.length <= 3) return d;
    if (d.length <= 6) return d.slice(0, 3) + "-" + d.slice(3);
    return d.slice(0, 3) + "-" + d.slice(3, 6) + "-" + d.slice(6);
  }

  function eligible(el) {
    if (!el || el.tagName !== "INPUT") return false;
    if ((el.getAttribute("type") || "").toLowerCase() !== "tel") return false;
    if (el.hasAttribute("data-no-phone-format")) return false;
    var ml = parseInt(el.getAttribute("maxlength") || "0", 10);
    if (ml > 0 && ml < 12) return false; // last-4 / short fields left alone
    return true;
  }

  function onInput(e) {
    var el = e.target;
    if (!eligible(el)) return;
    var before = el.value;
    // remember how many digits sit left of the caret, to restore it after reformat
    var caret = el.selectionEnd;
    var digitsLeft = (caret == null ? before : before.slice(0, caret)).replace(/\D/g, "").length;
    var after = formatPhone(before);
    if (after === before) return;
    el.value = after;
    // put the caret back after the same number of digits
    var pos = 0, seen = 0;
    while (pos < after.length && seen < digitsLeft) {
      if (/\d/.test(after.charAt(pos))) seen++;
      pos++;
    }
    try { el.setSelectionRange(pos, pos); } catch (_) {}
  }

  function wire(el) {
    if (!eligible(el) || el.__phoneWired) return;
    el.__phoneWired = true;
    el.setAttribute("inputmode", "tel");
    if (el.value) el.value = formatPhone(el.value); // format any pre-filled value
    el.addEventListener("input", onInput);
    el.addEventListener("blur", function () { if (eligible(el)) el.value = formatPhone(el.value); });
  }

  function scan(root) {
    var scope = root && root.querySelectorAll ? root : document;
    var list;
    try { list = scope.querySelectorAll('input[type="tel"]'); } catch (_) { return; }
    for (var i = 0; i < list.length; i++) wire(list[i]);
  }

  function start() {
    scan(document);
    // Phone fields on the loyalty/staff/admin tools are drawn after the page
    // loads, so watch the page and wire up any that appear later.
    try {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (!n || n.nodeType !== 1) continue;
            if (n.matches && n.matches('input[type="tel"]')) wire(n);
            if (n.querySelectorAll) scan(n);
          }
        }
      });
      mo.observe(document.documentElement || document.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
