/* Little Haven — Square Web Payments SDK wallet controller
 * Apple Pay + Google Pay + Cash App Pay
 * All wallet tokens are sent through the same Square Payments API backend as cards.
 */
(function () {
  "use strict";

  const dollarAmount = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n.toFixed(2) : "0.00";
  };

  window.initSquareWallets = async function initSquareWallets(opts) {
    const payments = opts && opts.payments;
    if (!payments) return { any: false, refresh: async () => {} };

    const wrapEl = opts.wrapEl || null;
    const appleEl = opts.applePayEl || null;
    const googleEl = opts.googlePayEl || null;
    const cashEl = opts.cashAppEl || null;
    const getAmount = opts.getAmount || (() => "0.00");
    const validate = opts.validate || (() => true);
    const onToken = opts.onToken || (async () => {});
    const label = opts.label || "Little Haven Play Studio";
    const referenceId = opts.referenceId || "little-haven";

    let applePay = null;
    let googlePay = null;
    let cashAppPay = null;
    let lastAmount = null;
    let rebuildVersion = 0;
    let busy = false;
    let appleBound = false;
    let googleBound = false;
    let cashGuardBound = false;

    const show = (el, yes) => { if (el) el.style.display = yes ? "" : "none"; };
    const clear = (el) => { if (el) el.innerHTML = ""; };

    function paymentRequest(amount) {
      return payments.paymentRequest({
        countryCode: "US",
        currencyCode: "USD",
        total: { amount, label },
      });
    }

    const controller = {
      any: false,
      refresh: async function (force) {
        const amount = dollarAmount(getAmount());
        if (!force && amount === lastAmount) {
          updateWrap();
          return;
        }
        lastAmount = amount;
        await rebuild(amount);
      },
    };

    function updateWrap() {
      const visible = [appleEl, googleEl, cashEl].some(
        (el) => el && el.style.display !== "none"
      );
      controller.any = visible;
      if (wrapEl) wrapEl.style.display = visible ? "" : "none";
    }

    async function deliver(result) {
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

    function bindApple() {
      if (!appleEl || appleBound) return;
      appleBound = true;
      appleEl.addEventListener("click", async function (event) {
        event.preventDefault();
        if (busy || !applePay || !validate()) return;
        busy = true;
        try {
          // Required by Apple/Square: tokenize immediately from this user click.
          const result = await applePay.tokenize();
          await deliver(result);
        } catch (_) {
          busy = false;
        }
      });
    }

    function bindGoogle() {
      if (!googleEl || googleBound) return;
      googleBound = true;
      googleEl.addEventListener("click", async function (event) {
        if (busy || !googlePay) return;
        if (!validate()) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        busy = true;
        try {
          const result = await googlePay.tokenize();
          await deliver(result);
        } catch (_) {
          busy = false;
        }
      });
    }

    function bindCashGuard() {
      if (!cashEl || cashGuardBound) return;
      cashGuardBound = true;
      cashEl.addEventListener("click", function (event) {
        if (busy || !validate()) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    }

    async function destroy(method) {
      if (method && typeof method.destroy === "function") {
        try { await method.destroy(); } catch (_) {}
      }
    }

    async function rebuild(amount) {
      const version = ++rebuildVersion;

      await destroy(googlePay);
      await destroy(cashAppPay);
      googlePay = null;
      cashAppPay = null;
      applePay = null;

      clear(googleEl);
      clear(cashEl);
      show(appleEl, false);
      show(googleEl, false);
      show(cashEl, false);

      // Wallets cannot initialize against a zero-dollar PaymentRequest.
      if (Number(amount) <= 0 || version !== rebuildVersion) {
        updateWrap();
        return;
      }

      // Apple Pay object must be initialized before the buyer clicks.
      if (appleEl) {
        try {
          const method = await payments.applePay(paymentRequest(amount));
          if (version === rebuildVersion) {
            applePay = method;
            bindApple();
            show(appleEl, true);
          }
        } catch (_) {
          show(appleEl, false);
        }
      }

      if (googleEl && version === rebuildVersion) {
        try {
          const method = await payments.googlePay(paymentRequest(amount));
          await method.attach(googleEl, { buttonType: "pay", buttonSizeMode: "fill" });
          if (version === rebuildVersion) {
            googlePay = method;
            bindGoogle();
            show(googleEl, true);
          } else {
            await destroy(method);
          }
        } catch (_) {
          clear(googleEl);
          show(googleEl, false);
        }
      }

      // Cash App PaymentRequest cannot be updated in place, so rebuild on amount changes.
      if (cashEl && version === rebuildVersion) {
        try {
          const method = await payments.cashAppPay(paymentRequest(amount), {
            redirectURL: window.location.origin + window.location.pathname + window.location.search,
            referenceId: (referenceId + "-" + Date.now()).slice(0, 40),
          });
          method.addEventListener("ontokenization", async function (event) {
            const detail = event && event.detail ? event.detail : {};
            const result = detail.tokenResult;
            if (!result || result.status !== "OK" || !validate()) {
              busy = false;
              return;
            }
            busy = true;
            await deliver(result);
          });
          bindCashGuard();
          await method.attach(cashEl, { shape: "semiround", width: "full" });
          if (version === rebuildVersion) {
            cashAppPay = method;
            show(cashEl, true);
          } else {
            await destroy(method);
          }
        } catch (_) {
          clear(cashEl);
          show(cashEl, false);
        }
      }

      updateWrap();
    }

    await controller.refresh(true);
    return controller;
  };
})();
