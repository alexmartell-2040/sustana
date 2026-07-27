#!/usr/bin/env node
/**
 * invoke-seed.mjs — call the SUST_RL_SeedDemo RESTlet with NetSuite Token-Based Auth.
 *
 * Reads all secrets from environment variables (never from args, never printed), so
 * the token/consumer secrets stay in your shell/env file and are never echoed:
 *   NS_ACCOUNT          e.g. TD2952281   (used for the realm + URL host)
 *   NS_CONSUMER_KEY     integration consumer key
 *   NS_CONSUMER_SECRET  integration consumer secret
 *   NS_TOKEN_ID         access token id
 *   NS_TOKEN_SECRET     access token secret
 *   NS_RESTLET_URL      (optional) full RESTlet URL; otherwise derived from NS_ACCOUNT
 *
 * Usage:  set -a; . ~/.sustana_seed.env; set +a; node scripts/invoke-seed.mjs
 * No external dependencies — Node's built-in crypto + fetch (Node 18+).
 */
import crypto from 'node:crypto';

const {
  NS_ACCOUNT, NS_CONSUMER_KEY, NS_CONSUMER_SECRET, NS_TOKEN_ID, NS_TOKEN_SECRET, NS_RESTLET_URL
} = process.env;

const missing = ['NS_ACCOUNT','NS_CONSUMER_KEY','NS_CONSUMER_SECRET','NS_TOKEN_ID','NS_TOKEN_SECRET']
  .filter((k) => !process.env[k]);
if (missing.length) {
  console.error('Missing env vars: ' + missing.join(', ') + '\nSet them (e.g. source ~/.sustana_seed.env) and retry.');
  process.exit(2);
}

// RFC-3986 percent-encoding (stricter than encodeURIComponent).
const pct = (s) => encodeURIComponent(s).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

const hostAccount = NS_ACCOUNT.toLowerCase().replace(/_/g, '-');
const method = 'POST';
const url = NS_RESTLET_URL ||
  `https://${hostAccount}.suitetalk.api.netsuite.com/app/site/hosting/restlet.nl` +
  `?script=customscript_sust_rl_seed_demo&deploy=customdeploy_sust_rl_seed_demo`;

const u = new URL(url);
const oauth = {
  oauth_consumer_key: NS_CONSUMER_KEY,
  oauth_token: NS_TOKEN_ID,
  oauth_signature_method: 'HMAC-SHA256',
  oauth_timestamp: String(Math.floor(Date.now() / 1000)),
  oauth_nonce: crypto.randomBytes(16).toString('hex'),
  oauth_version: '1.0',
};

// Signature base string includes query params + oauth params, sorted.
const params = {};
for (const [k, v] of u.searchParams) params[k] = v;
Object.assign(params, oauth);
const paramString = Object.keys(params).sort()
  .map((k) => `${pct(k)}=${pct(params[k])}`).join('&');
const baseUrl = `${u.origin}${u.pathname}`;
const baseString = [method, pct(baseUrl), pct(paramString)].join('&');
const signingKey = `${pct(NS_CONSUMER_SECRET)}&${pct(NS_TOKEN_SECRET)}`;
const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

const header = 'OAuth realm="' + NS_ACCOUNT.toUpperCase() + '", ' +
  Object.entries({ ...oauth, oauth_signature: signature })
    .map(([k, v]) => `${pct(k)}="${pct(v)}"`).join(', ');

const res = await fetch(url, {
  method,
  headers: { Authorization: header, 'Content-Type': 'application/json' },
  body: '{}',
});
const text = await res.text();
console.log('HTTP ' + res.status);
try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
catch { console.log(text); }        // print the RESTlet response only — never the secrets
process.exit(res.ok ? 0 : 1);
