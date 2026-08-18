// BigBooks dashboard configuration.
//
// Fill in CLIENT_ID with a PUBLIC OAuth client registered in BigBooks
// (token endpoint auth method "none", PKCE / S256). That client must have:
//   • Redirect URI  = this app's URL, e.g. http://localhost:5173/
//   • Allowed web origin (CORS) = this app's origin, e.g. http://localhost:5173
//
// No client secret goes here — this file ships to the browser. PKCE replaces it.

export const CONFIG = {
  CLIENT_ID: '',                                  // <-- your public client_id

  BASE: 'https://staging.bigbooks.app',
  API: 'https://staging.bigbooks.app/api',
  AUTHORIZE_URL: 'https://staging.bigbooks.app/oauth2/authorize',
  TOKEN_URL: 'https://staging.bigbooks.app/oauth2/token',
  USERINFO_URL: 'https://staging.bigbooks.app/oauth2/userInfo',

  // openid is required to receive the userInfo `bigbooks:party` claim.
  SCOPES: 'openid profile email',

  // Where the OAuth redirect lands. Must exactly match a registered redirect URI.
  REDIRECT_URI: window.location.origin + window.location.pathname,
};
