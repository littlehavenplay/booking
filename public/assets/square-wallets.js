/* Little Haven — Square Web Payments SDK wallets
 * Apple Pay + Google Pay + Cash App Pay
 * Uses cents->dollars from caller, updates Apple/Google PaymentRequest in place,
 * and safely rebuilds Cash App Pay when the amount changes.
 */
(function () {
  const money = (value) => {
    const n = Number(value);
    return (Number.isFinite(n) && n > 0 ? n : 0).toFixed(2);
  };

  window.initSquareWallets = async function initSquareWallets(opts) {
    const payments = opts && opts.payments;
    if (!payments) return { any: false, refresh() {}, destroy() {} };

    const getAmount = opts.getAmount || (() => "0.00");
    const label = opts.label || "Little Haven Play Studio";
    const validate = opts.validate || (() => true);
    const onToken = opts.onToken || (async () => {});
    const wrapEl = opts.wrapEl || null;
    const appleEl = opts.applePayEl || null;
    const googleEl = opts.googlePayEl || null;
    const cashEl = opts.cashAppEl || null;

    let any = false;
    let applePay = null;
    let googlePay = null;
    let cashAppPay = null;
    let sharedRequest = null;
    let cashBuildSerial = 0;
    let lastAmount = money(getAmount());

    const total = () => ({ amount: money(getAmount()), label, pending: false });
    const makeRequest = () => payments.paymentRequest({
      countryCode: "US",
      currencyCode: "USD",
      total: total(),
    });

    const showWrapIfNeeded = () => {
      if (wrapEl) wrapEl.style.display = any ? "" : "none";
    };

    const deliverToken = async (token, method) => {
      if (!token) return;
      if (!validate()) return;
      try {
        await onToken(token, method);
      } catch (e) {
        console.error("Square wallet payment submission failed", e);
      }
    };

    // Apple Pay and Google Pay may share an updatable PaymentRequest.
    // Cash App Pay cannot update its PaymentRequest, so it gets a separate one.
    sharedRequest = makeRequest();

    // Apple Pay: tokenize() must be called immediately from the click handler.
    if (appleEl) {
      try {
        applePay = await payments.applePay(sharedRequest);
        appleEl.style.display = "";
        any = true;
        appleEl.addEventListener("click", async (event) => {
          event.preventDefault();
          try {
            const result = await applePay.tokenize();
            if (result && result.status === "OK") {
              await deliverToken(result.token, "APPLE_PAY");
            } else if (result && result.status === "Error") {
              console.error("Apple Pay tokenization error", result.errors || result);
            }
          } catch (e) {
            console.error("Apple Pay failed", e);
          }
        });
      } catch (e) {
        appleEl.style.display = "none";
        console.info("Apple Pay unavailable", e && e.name ? e.name : e);
      }
    }

    // Google Pay
    if (googleEl) {
      try {
        googlePay = await payments.googlePay(sharedRequest);
        googleEl.innerHTML = "";
        await googlePay.attach(googleEl, {
          buttonColor: "black",
          buttonType: "long",
          buttonSizeMode: "fill",
          buttonRadius: 12,
          buttonBorderType: "no_border",
        });
        googleEl.style.display = "";
        any = true;
        googleEl.onclick = async (event) => {
          event.preventDefault();
          if (!validate()) return;
          try {
            const result = await googlePay.tokenize();
            if (result && result.status === "OK") {
              await deliverToken(result.token, "GOOGLE_PAY");
            } else if (result && result.status === "Error") {
              console.error("Google Pay tokenization error", result.errors || result);
            }
          } catch (e) {
            console.error("Google Pay failed", e);
          }
        };
      } catch (e) {
        googleEl.style.display = "none";
        console.info("Google Pay unavailable", e && e.name ? e.name : e);
      }
    }

    async function rebuildCashApp() {
      if (!cashEl) return;
      const serial = ++cashBuildSerial;
      try {
        if (cashAppPay) {
          try { await cashAppPay.destroy(); } catch (_) {}
          cashAppPay = null;
        }
        if (serial !== cashBuildSerial) return;
        cashEl.innerHTML = "";

        const request = makeRequest();
        const next = await payments.cashAppPay(request, {
          redirectURL: window.location.origin + window.location.pathname + window.location.search,
          referenceId: (opts.referenceId || "little-haven") + "-" + Date.now(),
        });
        if (serial !== cashBuildSerial) {
          try { await next.destroy(); } catch (_) {}
          return;
        }

        next.addEventListener("ontokenization", async (event) => {
          const detail = event && event.detail ? event.detail : {};
          if (detail.error) {
            console.error("Cash App Pay tokenization error", detail.error);
            return;
          }
          const result = detail.tokenResult;
          if (result && result.status === "OK") {
            await deliverToken(result.token, "CASH_APP_PAY");
          }
        });

        cashAppPay = next;
        await cashAppPay.attach(cashEl, {
          shape: "semiround",
          theme: "dark",
          width: "full",
        });
        cashEl.style.display = "";
        any = true;
        showWrapIfNeeded();
      } catch (e) {
        if (serial === cashBuildSerial) {
          cashEl.style.display = "none";
          console.info("Cash App Pay unavailable", e && e.name ? e.name : e);
        }
      }
    }

    await rebuildCashApp();
    showWrapIfNeeded();

    return {
      get any() { return any; },
      async refresh() {
        const nextAmount = money(getAmount());
        if (nextAmount === lastAmount) return;
        lastAmount = nextAmount;

        // Apple Pay + Google Pay support PaymentRequest.update while sheets are closed.
        try {
          if (sharedRequest && typeof sharedRequest.update === "function") {
            sharedRequest.update({ total: total() });
          }
        } catch (e) {
          console.warn("Could not update Apple/Google Pay amount", e);
        }

        // Cash App Pay explicitly does not support PaymentRequest.update.
        await rebuildCashApp();
      },
      async destroy() {
        cashBuildSerial++;
        try { if (googlePay) await googlePay.destroy(); } catch (_) {}
        try { if (cashAppPay) await cashAppPay.destroy(); } catch (_) {}
      },
    };
  };
})();
