/* Little Haven — Square digital wallets (Apple Pay, Google Pay, Cash App Pay)
 *
 * Adds one-tap wallet buttons to a Square Web Payments SDK checkout. It is fully
 * ADDITIVE and FAIL-SAFE: every wallet is wrapped in try/catch, and if a wallet is
 * unavailable or errors, its button is hidden and the normal card form keeps working.
 * The wallet token is processed by the SAME backend call as a card (Square doesn't
 * care whether a token came from a card or a wallet).
 *
 * Usage:
 *   const controls = await window.initSquareWallets({
 *     payments,                       // the Square.payments(appId, locationId) instance
 *     wrapEl, applePayEl, googlePayEl, cashAppEl,   // DOM elements (containers)
 *     getAmount: () => "25.00",       // current total as a string in dollars
 *     label: "Little Haven Play Studio",
 *     referenceId: "open-play",       // short id for Cash App Pay
 *     validate: () => true,           // run form validation before opening a wallet; return false to abort
 *     onToken: (token) => submit(token),  // called with a payment token on success
 *   });
 *   // when the total changes:  controls.refresh();
 */
(function () {
  function amt(v) { const n = Number(v); return (isNaN(n) ? 0 : n).toFixed(2); }

  window.initSquareWallets = async function (opts) {
    const payments = opts.payments;
    if (!payments) return { refresh() {}, any: false };
    const getAmount = opts.getAmount || (() => "0.00");
    const label = opts.label || "Little Haven Play Studio";
    const validate = opts.validate || (() => true);
    const onToken = opts.onToken || function () {};
    let any = false;

    function buildRequest() {
      return payments.paymentRequest({
        countryCode: "US",
        currencyCode: "USD",
        total: { amount: amt(getAmount()), label },
      });
    }

    // ---- Apple Pay (Safari + supported browsers). No attach(); we use our own button. ----
    let applePay = null;
    if (opts.applePayEl) {
      try {
        applePay = await payments.applePay(buildRequest());
        opts.applePayEl.style.display = "";
        any = true;
        opts.applePayEl.addEventListener("click", async function () {
          if (!validate()) return;
          try {
            // rebuild with the current amount right before charging
            applePay = await payments.applePay(buildRequest());
            const r = await applePay.tokenize();
            if (r && r.status === "OK") onToken(r.token);
          } catch (e) { /* buyer cancelled or error — card form still available */ }
        });
      } catch (e) { if (opts.applePayEl) opts.applePayEl.style.display = "none"; }
    }

    // ---- Google Pay ----
    // Rebuild whenever the total changes so the Google Pay sheet always uses
    // the same amount currently shown at checkout.
    let googlePay = null;
    async function buildGooglePay() {
      if (!opts.googlePayEl) return;
      try {
        if (googlePay) {
          try { await googlePay.destroy(); } catch (e) {}
          opts.googlePayEl.innerHTML = "";
        }
        googlePay = await payments.googlePay(buildRequest());
        await googlePay.attach(opts.googlePayEl, { buttonType: "pay", buttonSizeMode: "fill" });
        opts.googlePayEl.style.display = "";
        any = true;
        opts.googlePayEl.onclick = async function () {
          if (!validate()) return;
          try {
            const r = await googlePay.tokenize();
            if (r && r.status === "OK") onToken(r.token);
          } catch (e) { /* cancelled or error */ }
        };
      } catch (e) {
        opts.googlePayEl.style.display = "none";
      }
    }
    await buildGooglePay();

    // ---- Cash App Pay (event-based) ----
    let cashAppPay = null;
    async function buildCashApp() {
      if (!opts.cashAppEl) return;
      try {
        if (cashAppPay) { try { await cashAppPay.destroy(); } catch (e) {} opts.cashAppEl.innerHTML = ""; }
        cashAppPay = await payments.cashAppPay(buildRequest(), {
          redirectURL: window.location.href,
          referenceId: (opts.referenceId || "lh") + "-" + Date.now(),
        });
        cashAppPay.addEventListener("ontokenization", function (ev) {
          const tr = ev && ev.detail && ev.detail.tokenResult;
          if (tr && tr.status === "OK") {
            if (!validate()) return;
            onToken(tr.token);
          }
        });
        await cashAppPay.attach(opts.cashAppEl, { shape: "semiround", width: "full" });
        any = true;
      } catch (e) { if (opts.cashAppEl) opts.cashAppEl.style.display = "none"; }
    }
    await buildCashApp();

    if (any && opts.wrapEl) opts.wrapEl.style.display = "";

    return {
      any,
      // Google Pay and Cash App Pay both depend on the current PaymentRequest amount,
      // so rebuild those methods when the checkout total changes. Apple Pay rebuilds
      // its request immediately before tokenization.
      refresh: function () {
        if (!any) return;
        buildGooglePay();
        buildCashApp();
      },
    };
  };
})();
