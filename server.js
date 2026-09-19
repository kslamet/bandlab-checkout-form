import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import Stripe from 'stripe';

// Resolve the static directory from this module's location, not process.cwd().
// In a Vercel serverless function the cwd is /var/task, so a relative
// express.static('public') resolves to a directory that does not exist and every
// request falls through to Express's "Cannot GET /" 404.
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const {
  STRIPE_SECRET_KEY,
  STRIPE_PUBLISHABLE_KEY,
  STRIPE_API_VERSION,
  PRICE_ID,
  DEFAULT_PROMOTION_CODE = '20OFF',
  ALTERNATE_PROMOTION_CODE = '25OFF',
  PORT = 4242,
  APP_URL,
} = process.env;

// Config is validated per request rather than at import time. On Vercel the
// module is loaded inside a serverless function, where process.exit would take
// down the invocation with no useful response.
const configProblems = () =>
  Object.entries({ STRIPE_SECRET_KEY, STRIPE_PUBLISHABLE_KEY, PRICE_ID })
    .filter(([, value]) => !value || value.includes('REPLACE_ME'))
    .map(([name]) => name);

// ui_mode: 'form' requires 2026-03-25.dahlia or later. Without pinning, the SDK
// uses the account's default API version, and an older default fails at
// loadActions() with:
//   Invalid ui_mode: form. In order to use ui_mode: form, you must upgrade to
//   Stripe API version 2026-03-25.dahlia.
// Pinned rather than left to the account default so the app does not depend on a
// Dashboard setting. STRIPE_API_VERSION overrides it if you need a later release.
const MIN_API_VERSION = '2026-03-25.dahlia';
const apiVersion = STRIPE_API_VERSION || MIN_API_VERSION;

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY, { apiVersion }) : null;

// Derive the origin from the request so preview deployments, production, and
// localhost all produce a correct return_url without hardcoding a domain.
const originOf = (req) => {
  if (APP_URL) return APP_URL;
  const proto = req.headers['x-forwarded-proto'] ?? 'http';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return `${proto}://${host}`;
};

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

// Explicit index route, in case the static middleware is bypassed by a rewrite.
app.get('/', (_req, res, next) => {
  const index = path.join(publicDir, 'index.html');
  if (!fs.existsSync(index)) return next();
  res.sendFile(index);
});

// Diagnostic. Confirms whether the static files shipped inside the function
// bundle, which is not visible from outside when SSO protection is enabled.
app.get('/healthz', (_req, res) => {
  let files = [];
  try {
    files = fs.readdirSync(publicDir);
  } catch {
    files = ['<publicDir unreadable>'];
  }
  res.json({
    ok: true,
    apiVersion,
    cwd: process.cwd(),
    publicDir,
    publicDirExists: fs.existsSync(publicDir),
    files,
    configMissing: configProblems(),
  });
});

const guard = (handler) => async (req, res) => {
  const missing = configProblems();
  if (missing.length) {
    return res.status(500).json({
      error: `Server is not configured. Missing or placeholder: ${missing.join(', ')}`,
    });
  }
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`${req.method} ${req.path} failed:`, error.message);
    res.status(400).json({ error: error.message });
  }
};

// Each route is registered at both /x and /api/x so the app behaves the same
// whether Vercel rewrites the path or preserves it.
const route = (method, path, handler) => {
  app[method](path, handler);
  app[method](`/api${path}`, handler);
};

route(
  'get',
  '/config',
  guard(async (_req, res) => {
    res.json({
      publishableKey: STRIPE_PUBLISHABLE_KEY,
      defaultPromotionCode: DEFAULT_PROMOTION_CODE,
      alternatePromotionCode: ALTERNATE_PROMOTION_CODE,
    });
  })
);

route(
  'post',
  '/create-checkout-session',
  guard(async (req, res) => {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      // "Embedded form" is ui_mode: form. This is NOT embedded_page.
      ui_mode: 'form',
      line_items: [{ price: PRICE_ID, quantity: 1 }],

      // Required so the client may call applyPromotionCode / removePromotionCode.
      // Do NOT also pass `discounts`: Stripe rejects both together with
      // "You may only specify one of these parameters: allow_promotion_codes, discounts."
      // The 20OFF code is applied client-side on load instead, which is what makes
      // it removable. A server-applied discount cannot be removed by the customer.
      allow_promotion_codes: true,

      // Required if Managed Payments is enabled by default on the account.
      // ui_mode "form" requires gating to be compatible with Managed Payments, request this from your Stripe contact.
      managed_payments: { enabled: true },

      return_url: `${originOf(req)}/return.html?session_id={CHECKOUT_SESSION_ID}`,

      // Optional: lets you measure this integration's conversion separately.
      integration_identifier: 'bandlab_form_coupon_demo',
    });

    res.json({ client_secret: session.client_secret });
  })
);

// Used by the return page. Treat the webhook as the source of truth for
// fulfilment; this is only for showing the customer a result.
route(
  'get',
  '/session-status',
  guard(async (req, res) => {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id, {
      expand: ['subscription'],
    });
    res.json({
      status: session.status,
      payment_status: session.payment_status,
      amount_subtotal: session.amount_subtotal,
      amount_total: session.amount_total,
      amount_discount: session.total_details?.amount_discount ?? 0,
      currency: session.currency,
      discounts: session.discounts,
      subscription_id: session.subscription?.id ?? null,
    });
  })
);

// Only listen when run directly. On Vercel the app is imported by api/index.js
// and invoked per request instead.
if (!process.env.VERCEL) {
  const missing = configProblems();
  if (missing.length) {
    console.warn(`Warning: missing or placeholder env vars: ${missing.join(', ')}`);
  }
  app.listen(PORT, () => console.log(`Listening on ${APP_URL ?? `http://localhost:${PORT}`}`));
}

export default app;
