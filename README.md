# BigBooks Net Worth Dashboard

A simple, **fully static** net worth dashboard built on the [BigBooks API](https://api.bigbooks.app).
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

## How it works

```
Browser (this static app)
  │  1. Authorization Code + PKCE  ──►  www.bigbooks.app/oauth2/authorize + /oauth2/token
  │  2. decode id_token            ──►  reads the `bigbooks:party` claim (your party id)
  │     (falls back to GET /oauth2/userInfo only if the claim isn't in the token)
  │  3. GET /v1/balance_sheets     ──►  net worth over time   (X-Acting-Party-ID = your party)
  │  4. GET /v1/accounts           ──►  asset/liability accounts with balances
```

The access token lives only in `sessionStorage` for the current tab.

### Linking accounts (Plaid)

The app loads Plaid's Link SDK (`cdn.plaid.com`) and drives the standard Link flow —
BigBooks holds the Plaid client id/secret, so none are needed in the browser:

```
Click "+ Link account"
  │  POST /v1/plaid/public/token               ──►  { token }  (a Plaid Link token)
  │  Plaid.create({ token }).open()            ──►  user authenticates with their bank
  │  onSuccess(public_token, metadata)
  │  POST /v1/plaid/access/token               ──►  server exchanges + saves the item
  │     { publicToken, party, linkSessionId, webhook, institution, accounts }
  └► refresh the dashboard
```

The exchange sets `webhook` to `…/v1/plaid/webhook` — the field is required, and it
must be the API's own webhook URL, which is what BigBooks itself registers when it
mints the Link token. Requires the BigBooks environment to have Plaid credentials
configured.

## Setup

### 1. Register a public OAuth client in BigBooks

Create one at **<https://www.bigbooks.app/clients>** (sign-in required). New clients are
**public** (`token_endpoint_auth_method: none`) with PKCE required by default. Configure:

- **Redirect URI**: the exact URL you'll serve this app from, e.g. `http://localhost:5173/`
- **Scopes**: `openid profile email` (`openid` is required — the app reads your
  party id from the `bigbooks:party` claim)

> **CORS.** The API (`https://api.bigbooks.app/v1/`) allows any origin. The authorization
> server's `/oauth2/token` and `/oauth2/userInfo` allow only origins derived from active
> clients' **registered redirect URIs** — so registering the redirect URI is the whole
> setup, there is no separate origin field. The allow-list updates within about a minute.
> Note that `http://localhost:5173` and `http://127.0.0.1:5173` are different origins, and
> pages opened via `file://` send `Origin: null`, which can never be allowed.

### 2. Configure the client id

Edit [`public/config.js`](public/config.js) and set `CLIENT_ID`:

```js
export const CONFIG = {
  CLIENT_ID: 'your-public-client-id',
  // ...everything else defaults to the production hosts
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
| Net worth over time | `GET /v1/balance_sheets?time_period=…&after_date=…&before_date=…` |
| Account balances | `GET /v1/accounts?include=balance&account_types=ASSET,LIABILITY` |
| Start Plaid Link | `POST /v1/plaid/public/token` → `{ token }` |
| Finish Plaid Link | `POST /v1/plaid/access/token` (exchange public token, save item) |

All API calls send `X-Acting-Party-ID: <your party id>`.

Further reading: the [integrator guide](https://api.bigbooks.app/docs/integrator-guide.md)
covers tenancy, concurrency, errors, and pagination conventions across every endpoint.

## See also

[envelope-budgeting-sample](https://github.com/BigBooksApp/envelope-budgeting-sample) — the
same static-app pattern over the budgeting API, with zero-based envelopes.
