const el = (id) => document.getElementById(id);

const fatal = (message) => {
  el('fatal').textContent = message;
  const hint = el('fatal-hint');
  if (hint) hint.hidden = false;
  console.error(message);
};

// Amounts on the Checkout SDK session are objects, not numbers:
//   StripeCheckoutAmount = { minorUnitsAmount: number, amount: string }
// `amount` is already formatted and localised, so prefer it.
const money = (value) => {
  if (!value) return '—';
  if (typeof value.amount === 'string') return value.amount;
  if (typeof value.minorUnitsAmount === 'number') {
    return (value.minorUnitsAmount / 100).toFixed(2);
  }
  return '—';
};

async function main() {
  const configResponse = await fetch('/config');
  const config = await configResponse.json().catch(() => ({}));

  // Surface the server's own message. Without this, a misconfigured server turns
  // into "Missing value for Stripe(): apiKey should be a string", which points at
  // the wrong place entirely.
  if (!configResponse.ok || config.error) {
    throw new Error(
      config.error ?? `GET /config returned ${configResponse.status}. Check /healthz.`
    );
  }

  const { publishableKey, defaultPromotionCode } = config;

  if (typeof publishableKey !== 'string' || !publishableKey.startsWith('pk_')) {
    throw new Error(
      'STRIPE_PUBLISHABLE_KEY is missing or malformed on the server. ' +
        'Set it for this environment, then redeploy. Check /healthz for what is missing.'
    );
  }

  const stripe = Stripe(publishableKey);

  // The SDK accepts a promise, so the session request and SDK init overlap.
  const clientSecret = fetch('/create-checkout-session', { method: 'POST' })
    .then((r) => r.json())
    .then((json) => {
      if (json.error) throw new Error(json.error);
      return json.client_secret;
    });

  const checkout = stripe.initCheckoutFormSdk({ clientSecret });

  // promotionCodeCollection: 'never' suppresses Stripe's own promo field inside
  // the form, so the left panel is the only coupon surface. Without this there
  // would be two inputs mutating the same session.
  const form = checkout.createForm({
    layout: 'expanded',
    features: { promotionCodeCollection: 'never' },
  });
  form.mount('#checkout-form');

  const loaded = await checkout.loadActions();
  if (loaded.type !== 'success') {
    fatal(`loadActions failed: ${loaded.error?.message ?? 'unknown error'}`);
    return;
  }
  const { actions } = loaded;

  // ---------- state ----------

  // The session is the single source of truth for what is applied. Tracking it in
  // a local variable let the UI drift out of sync with the form.
  let busy = false;
  let lastRequestedCode = null;

  const appliedDiscount = () => {
    const discounts = actions.getSession()?.discountAmounts;
    return Array.isArray(discounts) && discounts.length ? discounts[0] : null;
  };

  const setBusy = (value) => {
    busy = value;
    el('apply').disabled = value;
    el('code-input').disabled = value;
    el('remove').disabled = value;
    document.querySelectorAll('.quick').forEach((b) => (b.disabled = value));
  };

  const render = () => {
    const session = actions.getSession();
    const discount = appliedDiscount();

    // Prefer what Stripe reports. promotionCode can be null on a coupon applied
    // without a code, so fall back to displayName, then to what we asked for.
    const label = discount
      ? discount.promotionCode || discount.displayName || lastRequestedCode
      : null;

    el('applied').hidden = !discount;
    el('code-form').hidden = Boolean(discount);
    if (discount) el('applied-code').textContent = `${label} applied`;

    const total = session?.total;
    if (total) {
      el('t-subtotal').textContent = money(total.subtotal);
      el('t-total').textContent = money(total.total);

      const hasDiscount = Boolean(discount) && total.discount?.minorUnitsAmount > 0;
      el('discount-row').hidden = !hasDiscount;
      if (hasDiscount) el('t-discount').textContent = `−${money(total.discount)}`;
    }
  };

  const showError = (message) => {
    el('discount-error').textContent = message ?? '';
  };

  const removeCode = async () => {
    const result = await actions.removePromotionCode();
    if (result?.type === 'error') {
      showError(result.error?.message ?? 'Could not remove the discount');
      return false;
    }
    lastRequestedCode = null;
    return true;
  };

  const applyCode = async (rawCode) => {
    const code = (rawCode ?? '').trim().toUpperCase();
    if (!code) return;

    showError('');
    setBusy(true);
    try {
      // removePromotionCode clears all applied codes, and applying a second code
      // while one is active is rejected. So a swap is always remove then apply.
      if (appliedDiscount() && !(await removeCode())) return;

      const result = await actions.applyPromotionCode(code);
      if (result?.type === 'error') {
        // error.code is 'invalidCode' for an unknown or ineligible code
        showError(result.error?.message ?? `${code} could not be applied`);
        return;
      }

      lastRequestedCode = code;
      el('code-input').value = '';
    } finally {
      setBusy(false);
      render();
    }
  };

  // ---------- wiring ----------

  el('code-form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (!busy) applyCode(el('code-input').value);
  });

  el('remove').addEventListener('click', async () => {
    if (busy) return;
    showError('');
    setBusy(true);
    try {
      await removeCode();
    } finally {
      setBusy(false);
      render();
    }
  });

  document.querySelectorAll('.quick').forEach((button) => {
    button.addEventListener('click', () => {
      if (!busy) applyCode(button.dataset.code);
    });
  });

  // Re-render whenever the session changes, including changes the form itself
  // makes. Safe now that render() reads the session rather than local state.
  checkout.on('change', render);

  // Apply the default code on load so it reads as pre-applied, while staying
  // removable. A server-side `discounts` entry could not be removed.
  await applyCode(defaultPromotionCode);

  // ---------- confirmation ----------

  form.on('confirm', async (event) => {
    try {
      await actions.confirm({ formConfirmEvent: event });
    } catch (error) {
      fatal(error?.message ?? 'Payment confirmation failed');
    }
  });
}

main().catch((error) => fatal(error.message));
