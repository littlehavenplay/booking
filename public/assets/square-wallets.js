/* Little Haven Play Studio — Square wallet controller
   Stable production integration for Apple Pay, Google Pay, and Cash App Pay.
   Each method initializes independently; unsupported methods are hidden without
   affecting the others. All successful tokens go through the existing Square
   Payments API backend.
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
    if (!payments) return { any: false, refresh: async function () {} };

    const wrap = o.wrapEl || null;
    const appleEl = o.applePayEl || null;
    const googleEl = o.googlePayEl || null;
    const cashEl = o.cashAppEl || null;
    const getAmount = o.getAmount || function () { return "0.00"; };
    const validate = o.validate || function () { return true; };
    const onToken = o.onToken || async function () {};
    const label = o.label || "Little Haven Play Studio";
    const referenceId = o.referenceId || "little-haven";

    let applePay = null;
    let googlePay = null;
    let cashAppPay = null;
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

    async function sendToken(result) {
      if (!result || result.status !== "OK" || !result.token) {
        busy = false;
        return;
      }
      try {
        await onToken(result.token);
      } finally {
        busy = false;
      }
    }

    const controller = {
      any: false,
      methods: { applePay: false, googlePay: false, cashAppPay: false },
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
        controller.any = !!(
          controller.methods.applePay ||
          controller.methods.googlePay ||
          controller.methods.cashAppPay
        );
        if (wrap) wrap.style.display = controller.any ? "" : "none";
      }
    };

    async function rebuild(amount) {
      const myId = ++refreshId;

      // Clean up old amount-specific wallet instances.
      await Promise.all([
        destroy(applePay),
        destroy(googlePay),
        destroy(cashAppPay)
      ]);
      applePay = null;
      googlePay = null;
      cashAppPay = null;

      controller.methods.applePay = false;
      controller.methods.googlePay = false;
      controller.methods.cashAppPay = false;

      if (appleEl) show(appleEl, false);
      if (googleEl) { empty(googleEl); show(googleEl, false); }
      if (cashEl) { empty(cashEl); show(cashEl, false); }

      if (Number(amount) <= 0 || myId !== refreshId) {
        controller.syncVisibility();
        return;
      }

      // Make the wallet area measurable while Square attaches official buttons.
      // It is hidden again below only if none of the methods is eligible.
      if (wrap) {
        wrap.style.display = "";
        wrap.style.visibility = "hidden";
      }

      // APPLE PAY
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
                // Apple/Square require tokenize() to start directly from the click.
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

      // GOOGLE PAY — selector-based attach matches Square's documented integration.
      if (googleEl && myId === refreshId) {
        try {
          show(googleEl, true);
          const method = await payments.googlePay(requestFor(amount));
          const target = selectorFor(googleEl);
          await method.attach(target, {
            buttonColor: "black",
            buttonType: "pay",
            buttonSizeMode: "fill"
          });

          if (myId === refreshId) {
            googlePay = method;
            controller.methods.googlePay = true;

            googleEl.onclick = async function (event) {
              if (busy || !googlePay) return;
              if (!validate()) {
                event.preventDefault();
                event.stopPropagation();
                return;
              }
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

      // CASH APP PAY — rebuilt when amount changes because Square documents
      // PaymentRequest updates as unsupported for Cash App Pay.
      if (cashEl && myId === refreshId) {
        try {
          show(cashEl, true);
          const method = await payments.cashAppPay(requestFor(amount), {
            redirectURL: window.location.origin + window.location.pathname + window.location.search,
            referenceId: (referenceId + "-" + Date.now()).slice(0, 40)
          });

          method.addEventListener("ontokenization", async function (event) {
            const detail = event && event.detail ? event.detail : {};
            if (detail.error) {
              busy = false;
              log("Cash App Pay", detail.error);
              return;
            }
            const result = detail.tokenResult;
            if (!result || result.status !== "OK") {
              busy = false;
              return;
            }
            if (!validate()) {
              busy = false;
              return;
            }
            busy = true;
            await sendToken(result);
          });

          // Use Square's documented default Cash App button attachment.
          await method.attach(selectorFor(cashEl));

          if (myId === refreshId) {
            cashAppPay = method;
            controller.methods.cashAppPay = true;
          } else {
            await destroy(method);
          }
        } catch (e) {
          log("Cash App Pay", e);
          empty(cashEl);
          show(cashEl, false);
        }
      }

      if (wrap) wrap.style.visibility = "";
      controller.syncVisibility();
    }

    await controller.refresh(true);
    return controller;
  };
})();
