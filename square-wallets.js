/* Little Haven Play Studio — Square wallet controller
   Apple Pay and Google Pay only. Cash App Pay was removed in August 2026.

   Each method initializes independently: if one is unavailable on the buyer's
   device, the other still shows. All successful tokens flow through the same
   Square Payments API backend as the manual card form.

   Apple and Google both require their own button appearance, so the buttons
   themselves are rendered by Apple/Square. Everything around them (frame,
   spacing, divider) is styled by the host page to match the site.
*/
(function () {
  "use strict";

  function amountString(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : "0.00";
  }

  function selectorFor(el) {
    return el && el.id ? "#" + el.id : null;
  }

  window.initSquareWallets = async function initSquareWallets(options) {
    const o = options || {};
    const payments = o.payments;
    if (!payments) return { any: false, methods: {}, refresh: async function () {} };

    const wrap = o.wrapEl || null;
    const appleEl = o.applePayEl || null;
    const googleEl = o.googlePayEl || null;
    const getAmount = o.getAmount || function () { return "0.00"; };
    const validate = o.validate || function () { return true; };
    const onToken = o.onToken || async function () {};
    const label = o.label || "Little Haven Play Studio";

    let applePay = null;
    let googlePay = null;
    let lastAmount = null;
    let refreshId = 0;
    let busy = false;

    function log(name, err) {
      try {
        console.warn("[Little Haven Square] " + name + " unavailable:", err && (err.message || err));
      } catch (_) {}
    }

    function show(el, yes) {
      if (!el) return;
      el.style.display = yes ? "" : "none";
    }

    function empty(el) {
      if (el) el.innerHTML = "";
    }

    function requestFor(amount) {
      return payments.paymentRequest({
        countryCode: "US",
        currencyCode: "USD",
        total: { amount: amount, label: label }
      });
    }

    async function destroy(method) {
      if (method && typeof method.destroy === "function") {
        try { await method.destroy(); } catch (_) {}
      }
    }

    // busy is only released once onToken has fully settled, so a double-tap
    // during submission cannot produce a second charge.
    async function sendToken(result) {
      if (!result || result.status !== "OK" || !result.token) {
        busy = false;
        return;
      }
      try {
        await onToken(result.token);
      } catch (e) {
        log("Payment submission", e);
      } finally {
        busy = false;
      }
    }

    const controller = {
      any: false,
      methods: { applePay: false, googlePay: false },
      refresh: async function (force) {
        const amount = amountString(getAmount());
        if (!force && amount === lastAmount) {
          controller.syncVisibility();
          return;
        }
        lastAmount = amount;
        await rebuild(amount);
      },
      syncVisibility: function () {
        controller.any = !!(controller.methods.applePay || controller.methods.googlePay);
        if (wrap) {
          wrap.style.display = controller.any ? "" : "none";
          if (wrap.classList) wrap.classList.toggle("lh-wallets-ready", controller.any);
        }
      }
    };

    async function rebuild(amount) {
      const myId = ++refreshId;

      await Promise.all([destroy(applePay), destroy(googlePay)]);
      applePay = null;
      googlePay = null;
      controller.methods.applePay = false;
      controller.methods.googlePay = false;

      if (appleEl) show(appleEl, false);
      if (googleEl) { empty(googleEl); show(googleEl, false); }

      if (Number(amount) <= 0 || myId !== refreshId) {
        controller.syncVisibility();
        return;
      }

      // Keep the wallet area measurable while Square attaches its buttons,
      // then reveal (or re-hide) it once we know what is eligible.
      if (wrap) {
        wrap.style.display = "";
        wrap.style.visibility = "hidden";
      }

      // ---- APPLE PAY -----------------------------------------------------
      // Square does not render an Apple Pay button; the page supplies one
      // styled with -apple-pay-button per Apple's guidelines.
      if (appleEl && myId === refreshId) {
        try {
          const method = await payments.applePay(requestFor(amount));
          if (myId === refreshId) {
            applePay = method;
            controller.methods.applePay = true;
            show(appleEl, true);

            appleEl.onclick = async function (event) {
              event.preventDefault();
              if (busy || !applePay || !validate()) return;
              busy = true;
              try {
                // Apple requires tokenize() to begin inside the click itself,
                // so nothing may be awaited before this line.
                await sendToken(await applePay.tokenize());
              } catch (e) {
                busy = false;
                log("Apple Pay", e);
              }
            };
          } else {
            await destroy(method);
          }
        } catch (e) {
          log("Apple Pay", e);
          show(appleEl, false);
        }
      }

      // ---- GOOGLE PAY ----------------------------------------------------
      if (googleEl && myId === refreshId) {
        try {
          show(googleEl, true);
          const method = await payments.googlePay(requestFor(amount));
          await method.attach(selectorFor(googleEl), {
            buttonColor: "black",
            buttonType: "pay",
            buttonSizeMode: "fill"
          });

          if (myId === refreshId) {
            googlePay = method;
            controller.methods.googlePay = true;

            googleEl.onclick = async function (event) {
              event.preventDefault();
              if (busy || !googlePay) return;
              if (!validate()) { event.stopPropagation(); return; }
              busy = true;
              try {
                await sendToken(await googlePay.tokenize());
              } catch (e) {
                busy = false;
                log("Google Pay", e);
              }
            };
          } else {
            await destroy(method);
          }
        } catch (e) {
          log("Google Pay", e);
          empty(googleEl);
          show(googleEl, false);
        }
      }

      if (myId !== refreshId) return;   // a newer rebuild took over
      if (wrap) wrap.style.visibility = "";
      controller.syncVisibility();
    }

    await controller.refresh(true);
    return controller;
  };
})();
