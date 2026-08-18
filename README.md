# BigBooks Net Worth Dashboard

A simple, **fully static** net worth dashboard built on the [BigBooks API](https://staging.bigbooks.app).
No backend, no build step — just HTML, CSS, and vanilla JS. Authentication uses
**OAuth 2.0 Authorization Code + PKCE** entirely in the browser, so there is no
client secret to protect and nothing runs server-side.

It shows:

- **Current net worth** with the change over the selected period
- **Assets, liabilities, cash on hand, and purchase power** tiles
- A **net worth trend chart** (Monthly / Quarterly / Yearly) with hover tooltips
- An **account breakdown** grouped into assets and liabilities
- **Link a bank/card/investment account via Plaid** — the "+ Link account" button
  (and the first-run empty state) opens Plaid Link and imports the accounts

![dashboard](https://staging.bigbooks.app/) <!-- replace with a screenshot if you like -->

## How it works

```
Browser (this static app)
  │  1. Authorization Code + PKCE  ──►  staging.bigbooks.app/oauth2/authorize + /oauth2/token
  │  2. decode id_token            ──►  reads the `bigbooks:party` claim (your party id)
  │     (falls back to GET /oauth2/userInfo only if the claim isn't in the token)
  │  3. GET /api/v1/balance_sheets ──►  net worth over time   (X-Acting-Party-ID = your party)
  │  4. GET /api/v1/accounts       ──►  asset/liability accounts with balances
```

The access token lives only in `sessionStorage` for the current tab.

### Linking accounts (Plaid)

The app loads Plaid's Link SDK (`cdn.plaid.com`) and drives the standard Link flow —
BigBooks holds the Plaid client id/secret, so none are needed in the browser:

```
Click "+ Link account"
  │  POST /api/v1/plaid/public/token           ──►  { token }  (a Plaid Link token)
  │  Plaid.create({ token }).open()            ──►  user authenticates with their bank
  │  onSuccess(public_token, metadata)
  │  POST /api/v1/plaid/access/token           ──►  server exchanges + saves the item
  │     { publicToken, party, linkSessionId, webhook, institution, accounts }
  └► refresh the dashboard
```

The exchange sets `webhook` to `…/api/v1/plaid/webhook` so BigBooks receives Plaid
item updates. Requires the BigBooks environment to have Plaid credentials configured
(staging uses Plaid Sandbox — use the Sandbox test institutions/credentials).

## Setup

### 1. Register a public OAuth client in BigBooks

You need a **public** client (token-endpoint auth method `none`, PKCE / `S256`). Configure it with:

- **Redirect URI**: the exact URL you'll serve this app from, e.g. `http://localhost:5173/`
- **Allowed web origin (CORS)**: the origin, e.g. `http://localhost:5173`
- **Scopes**: `openid profile email` (`openid` is required — the app reads your
  party id from the `bigbooks:party` userInfo claim)

> **CORS status.** Because the page calls these hosts directly from the browser,
> each must return `Access-Control-Allow-Origin` for your web origin.
> - `/api/*` — ✅ CORS enabled (`Access-Control-Allow-Origin: *`).
> - `/oauth2/token` — **must have CORS enabled** for the PKCE token exchange to
>   work from the browser. As of this writing a cross-origin request is rejected
>   with `403` (no `Access-Control-Allow-Origin`). If sign-in fails with a network
>   error, this is the cause.
> - `/oauth2/userInfo` — only needed as a fallback. The app first reads your
>   `bigbooks:party` claim from the **id_token**, so if that claim is present in
>   the id_token this endpoint is never called and doesn't need CORS.

### 2. Configure the client id

Edit [`public/config.js`](public/config.js) and set `CLIENT_ID`:

```js
export const CONFIG = {
  CLIENT_ID: 'your-public-client-id',
  // ...everything else defaults to staging.bigbooks.app
};
```

### 3. Serve the `public/` folder

Any static file server works — the app just needs to be served over `http://`
(ES modules and OAuth redirects don't work from `file://`). For example:

```bash
python3 -m http.server 5173 --directory public
```

Then open <http://localhost:5173> and click **Sign in with BigBooks**.

> The URL, port, and path must match the redirect URI / origin you registered in step 1.

## Demo mode (no account needed)

To preview the UI with synthetic data and no sign-in, open:

```
http://localhost:5173/#demo
```

## Project layout

```
public/
  index.html    # markup + auth gate
  styles.css    # theming (light/dark), palette, layout
  config.js     # ← your CLIENT_ID and endpoints
  app.js        # PKCE auth, API calls, SVG chart, rendering
openapi.json    # the BigBooks API spec, for reference
.claude/
  launch.json   # convenience config to serve public/ on :5173
```

## API endpoints used

| Purpose | Endpoint |
| --- | --- |
| Your party id | `GET /oauth2/userInfo` → `bigbooks:party` |
| Net worth over time | `GET /api/v1/balance_sheets?time_period=…&after_date=…&before_date=…` |
| Account balances | `GET /api/v1/accounts?include=balance&account_types=ASSET,LIABILITY` |
| Start Plaid Link | `POST /api/v1/plaid/public/token` → `{ token }` |
| Finish Plaid Link | `POST /api/v1/plaid/access/token` (exchange public token, save item) |

All API calls send `X-Acting-Party-ID: <your party id>`.
