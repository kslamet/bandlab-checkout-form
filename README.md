# Embedded form checkout with a removable coupon

Node + Express demo of Stripe's **embedded form** (`ui_mode: 'form'`) selling the
annual subscription product, with `20OFF` applied on load that the customer can remove and replace with `25OFF`.

## Run it

```bash
npm install
cp .env.example .env      # fill in the two API keys
npm start                 # http://localhost:4242
```

Test card `4242 4242 4242 4242`, any future expiry, any CVC.

## Layout

Two panels, collapsing to one column under 900px:

| Left | Right |
|---|---|
| Product, **coupon input**, applied-code chip, order summary | Stripe embedded form |

The coupon UI is entirely ours. Stripe's built-in promotion code field is
suppressed inside the form, so there is exactly one coupon surface on the page.

## What to expect

1. Page loads, form mounts on the right, `20OFF` is applied automatically. The left
   panel shows a green "20OFF applied" chip and the summary reads 120.00, −24.00,
   96.00.
2. **Remove** on the chip clears it. The input reappears and the total returns to
   120.00.
3. Type `25OFF`, or click the `25OFF` shortcut, and the total becomes 90.00.
   Applying a code while another is active removes the first automatically.
4. An unknown code shows an inline error under the input and leaves the current
   discount untouched.
5. Pay on the right, and you land on `/return.html` with the session status.

## How the removable discount works

The obvious approach does not work. `discounts` and `allow_promotion_codes` are
mutually exclusive on a Checkout Session:

```
You may only specify one of these parameters: allow_promotion_codes, discounts.
```

A discount passed server-side in `discounts` also cannot be removed by the
customer. So instead:

- The session sets `allow_promotion_codes: true` and **no** `discounts`
- The browser calls `actions.applyPromotionCode('20OFF')` on load, which makes it
  look pre-applied while staying removable
- `actions.removePromotionCode()` clears it, then `applyPromotionCode('25OFF')`
  swaps

`removePromotionCode` clears *all* applied codes, and applying a second code while
one is active is rejected, so a swap is always remove-then-apply. That is why
`#swap` awaits the remove before applying.

Stripe's own promotion code field is suppressed with
`createForm({features: {promotionCodeCollection: 'never'}})` so the custom controls
are the only path. Set it to `'auto'` to let Stripe render the field instead, in
which case you can delete the custom controls from `index.html`.

## Version requirements

| Requirement | Value | Why |
|---|---|---|
| Stripe API version | `2026-03-25.dahlia` or later | `ui_mode: 'form'` does not exist earlier |
| Stripe.js | `https://js.stripe.com/dahlia/stripe.js` | `initCheckoutFormSdk` ships in Dahlia (v9) |
| Node | 20+ | — |

The API version is **pinned in `server.js`**, not left to the account default:

```js
const MIN_API_VERSION = '2026-03-25.dahlia';
new Stripe(STRIPE_SECRET_KEY, { apiVersion });
```

Without the pin, the SDK uses whatever the account default is. If that default
predates Dahlia, the session is created but the client fails at `loadActions()`:

```
Invalid ui_mode: form. In order to use ui_mode: form, you must upgrade to
Stripe API version 2026-03-25.dahlia.
```

Pinning in code means the app does not depend on a Dashboard setting, and works
against any account regardless of its default. `STRIPE_API_VERSION` overrides it
if you need a later Dahlia release. `/healthz` reports the version in use.

## Managed Payments is off, deliberately

```js
managed_payments: { enabled: false }
```

This is **required**, not a preference. `ui_mode: 'form'` is incompatible with
Managed Payments:

```
Invalid ui_mode: form. Managed Payments currently only supports
ui_mode: hosted_page and ui_mode: embedded_page.
```

If the account has Managed Payments enabled by default, omitting this line fails
session creation. The trade-off: with Managed Payments off, **you are the merchant
of record**, so tax calculation and remittance, fraud, disputes, and customer
support are yours. If merchant-of-record coverage is required, this integration is
not available and the options are `hosted_page` or `embedded_page`, where the
discount is either pre-applied or customer-entered, but not swappable.

## Deploying to Vercel

```bash
vercel link
vercel env add STRIPE_SECRET_KEY          # sk_test_...
vercel env add STRIPE_PUBLISHABLE_KEY     # pk_test_...
vercel env add PRICE_ID                   # price_1UGcWsGo5snFNHkBC1ocP4Cr
vercel env add DEFAULT_PROMOTION_CODE     # 20OFF
vercel env add ALTERNATE_PROMOTION_CODE   # 25OFF
vercel                                    # preview; add --prod to promote
```

Leave `APP_URL` unset in Vercel. Each deployment then derives its own origin from
the request headers, so `return_url` is correct on preview URLs and production
alike. Setting it to a localhost value breaks the return leg in the cloud.

After deploying, open `/healthz` first. It reports the resolved static directory,
whether the files shipped inside the function bundle, and any missing env vars.

### Why `vercel.json` looks the way it does

Note that `vercel.json` is schema-validated and rejects unknown properties, so it
cannot carry `//` comment keys. The rationale lives here instead.

- **`functions["api/index.js"].includeFiles: "public/**"`** bundles the static
  assets into the function. Vercel otherwise uploads `public/` as static assets
  only, and the directory is absent from the lambda filesystem, so
  `express.static` finds nothing and every request 404s with `Cannot GET /`.
- **`rewrites` sends every path to `/api`.** The first deploy showed `/` already
  reaching the Express function, so letting Express own both routing and static
  serving is more predictable than splitting that responsibility with Vercel's
  static handler.
- **`server.js` resolves `publicDir` from `import.meta.url`**, not from
  `process.cwd()`. The cwd inside a function is `/var/task`, so a relative
  `express.static('public')` points at a directory that does not exist.

### Deployment protection

New projects have Vercel SSO protection on, so every request from outside your
Vercel session redirects to `vercel.com/sso-api`. Fine for your own testing, but
the URL is unusable for anyone else until you turn it off under
**Project → Settings → Deployment Protection**.

## Files

| File | Purpose |
|---|---|
| `server.js` | Creates the session, serves static files, reads session status |
| `public/index.html` | Two-panel markup: coupon UI left, form mount right |
| `public/checkout.js` | SDK init, apply/remove/swap, summary rendering, confirm |
| `public/style.css` | Grid layout, discount card, totals |
| `public/return.html` | Post-payment result |
| `.env.example` | Placeholders, including the Bob price ID |

## Objects this expects

Created in Bob, in test mode:

| Object | ID |
|---|---|
| Product | `prod_VHAs0qszs0RN7R` (annual subscription product) |
| Price | `price_1UGcWsGo5snFNHkBC1ocP4Cr` (USD 120 / year) |
| Promotion code | `20OFF` |
| Promotion code | `25OFF` |

`applyPromotionCode` takes the **code string**, not the `promo_...` ID, so only the
price ID is needed in `.env`.

## Before production

- Fulfil on the [`checkout.session.completed`](https://docs.stripe.com/api/events/types#event_types-checkout.session.completed)
  webhook, not on the return page. `/session-status` here is display only.
- Both coupons are `duration: once`, so on an annual plan they discount the first
  invoice only. Change the coupon if you want recurring years discounted.
- Validate coupon eligibility server-side if a code should apply to only some
  plans. `applies_to` on a Coupon is **product**-scoped, not price-scoped, so it
  cannot distinguish monthly from annual within one product.
- `StripeCheckoutFormSdk` is annotated "Requires beta access" in the public
  `@stripe/stripe-js` types, though `ui_mode: 'form'` created cleanly over the API
  in this sandbox with no beta header. Confirm live-mode access before shipping.
