import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';

class SetupError extends Error {}
const scopes = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'];
export async function verifyFacebook(config, expectedUsername, request = fetch) {
  const graph = async (path, params, token) => {
    try {
      const response = await request(`https://graph.facebook.com/${config.version || 'v26.0'}/${path}?${new URLSearchParams(params)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: 'error', signal: AbortSignal.timeout(20000),
      });
      const data = await response.json();
      if (data?.error?.code === 190 && data.error.error_subcode === 463) throw new SetupError('The Facebook User token expired. Generate a fresh User token in Graph API Explorer, authorize the class Page, and replace META_FACEBOOK_USER_ACCESS_TOKEN in .dev.vars. No connection was changed.');
      if (!response.ok || !data || data.error) throw new SetupError();
      return data;
    } catch (error) { if (error instanceof SetupError && error.message) throw error; throw new SetupError(`Meta validation failed at ${path.split('?')[0]}. Check the app, token and permissions. No connection was changed.`); }
  };
  const exchanged = await graph('oauth/access_token', { grant_type: 'fb_exchange_token', client_id: config.appId, client_secret: config.secret, fb_exchange_token: config.token });
  if (!exchanged.access_token || !Number.isFinite(exchanged.expires_in) || exchanged.expires_in < 60) throw new SetupError('Meta did not return a valid long-lived User token. No connection was changed.');
  const token = exchanged.access_token;
  const result = await graph('debug_token', { input_token: token }, `${config.appId}|${config.secret}`);
  const data = result.data, now = Math.floor(Date.now() / 1000);
  if (!data?.is_valid || String(data.app_id) !== config.appId || data.type !== 'USER' || !scopes.every(scope => data.scopes?.includes(scope))) throw new SetupError('The token must be a valid Facebook USER token for this app with all four required permissions. No connection was changed.');
  const expiresAt = Math.min(now + exchanged.expires_in, ...[data.expires_at, data.data_access_expires_at].filter(n => Number.isFinite(n) && n > 0));
  if (expiresAt <= now + 60) throw new SetupError('The token or data access is expired. Generate a fresh User token.');
  const matches = []; let pageCount = 0;
  const discover = async edge => {
    let after;
    for (let page = 0; page < 10; page++) {
      const pages = await graph(edge, { fields: 'instagram_business_account{id,username}', limit: '100', ...(after ? { after } : {}) }, token);
      if (!Array.isArray(pages.data)) throw new SetupError('Facebook did not return linked Pages.');
      pageCount += pages.data.length;
      matches.push(...pages.data.map(p => p.instagram_business_account).filter(a => a?.username?.toLowerCase() === expectedUsername.toLowerCase()));
      if (!pages.paging?.next) break;
      after = pages.paging.cursors?.after;
      if (!after || page === 9) throw new SetupError('Page discovery was incomplete. No connection was changed.');
    }
  };
  await discover('me/accounts');
  if (!matches.length && config.businessId) {
    if (!/^\d{5,30}$/.test(config.businessId)) throw new SetupError('META_FACEBOOK_BUSINESS_ID must be the numeric business portfolio ID.');
    if (!data.scopes.includes('business_management')) throw new SetupError('This Page belongs to a business portfolio. Add business_management in Graph API Explorer, authorize the Bagh Haru portfolio, and replace META_FACEBOOK_USER_ACCESS_TOKEN. No connection was changed.');
    await discover(`${config.businessId}/owned_pages`);
  }
  if (!pageCount) throw new SetupError('Facebook returned no accessible Pages. Create or authorize the class Facebook Page, link the existing Instagram account, and generate a User token with that Page selected. No connection was changed.');
  const unique = [...new Map(matches.map(a => [a.id, a])).values()];
  if (unique.length !== 1 || !/^\d+$/.test(unique[0].id)) throw new SetupError('The authorized Pages do not identify the existing class Instagram account uniquely. Link and authorize that Page. No connection was changed.');
  const account = unique[0];
  await graph(`${account.id}/content_publishing_limit`, { fields: 'config,quota_usage' }, token);
  const catalog = await graph('ig_audio', { audio_type: 'music', user_id: account.id }, token);
  if (!Array.isArray(catalog.audio)) throw new SetupError('Meta did not return the expected audio catalog response. No connection was changed.');
  return { token, userId: account.id, username: account.username, expiresAt, verifiedAt: now };
}
async function encryptionKey(secret) {
  return webcrypto.subtle.importKey('raw', await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(`bagh-haru-meta-v1\0${secret}`)), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptConnection(secret, connection) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('meta_facebook_connection') }, await encryptionKey(secret), new TextEncoder().encode(JSON.stringify(connection)));
  return Buffer.from(iv).toString('base64url') + '.' + Buffer.from(encrypted).toString('base64url');
}
export async function decryptConnection(secret, value) {
  const [iv, cipher] = value.split('.');
  return JSON.parse(new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64url'), additionalData: new TextEncoder().encode('meta_facebook_connection') }, await encryptionKey(secret), Buffer.from(cipher, 'base64url'))));
}
export function databaseExecutor(accountId, run = execFileSync) {
  return async query => {
    let result;
    try { result = run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'insta-portal', '--remote', '--command', query, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId }, maxBuffer: 1024 * 1024 }); }
    catch { throw new SetupError('Cloudflare database command failed. Check Wrangler login. No provider credentials were printed.'); }
    try { const parsed = JSON.parse(result); if (!parsed.every(r => r.success)) throw new SetupError(); return parsed; }
    catch { throw new SetupError('Cloudflare returned an unexpected database response.'); }
  };
}
async function main() {
  const vars = parseEnv(await readFile('.dev.vars', 'utf8'));
  const required = ['META_FACEBOOK_APP_ID', 'META_FACEBOOK_APP_SECRET', 'META_FACEBOOK_USER_ACCESS_TOKEN', 'META_ACCESS_TOKEN', 'META_IG_USER_ID', 'MEDIA_URL_SECRET', 'R2_ACCOUNT_ID'];
  const missing = required.filter(name => !vars[name]?.trim());
  if (missing.length) throw new SetupError(`Fill these private .dev.vars entries first: ${missing.join(', ')}. Existing publishing is unchanged.`);
  if (!/^\d{5,30}$/.test(vars.META_FACEBOOK_APP_ID)) throw new SetupError('META_FACEBOOK_APP_ID must be the numeric App ID.');
  const execute = databaseExecutor(vars.R2_ACCOUNT_ID);
  {
    const prior = await execute("SELECT value FROM app_settings WHERE key='meta_facebook_connection';");
    const oldValue = prior[0]?.results[0]?.value ?? '';
    let expectedUsername;
    if (oldValue) expectedUsername = (await decryptConnection(vars.MEDIA_URL_SECRET, oldValue)).username;
    else {
      const response = await fetch(`https://graph.instagram.com/${vars.META_API_VERSION || 'v26.0'}/me?fields=user_id,username`, { headers: { Authorization: `Bearer ${vars.META_ACCESS_TOKEN}` }, signal: AbortSignal.timeout(20000), redirect: 'error' });
      const account = await response.json(); if (!response.ok || !account.username || String(account.user_id) !== vars.META_IG_USER_ID) throw new SetupError('Could not verify the current class Instagram identity. Existing publishing is unchanged.'); expectedUsername = account.username;
    }
    if (!expectedUsername) throw new SetupError('The saved connection has no verified class identity.');
    const connection = await verifyFacebook({ appId: vars.META_FACEBOOK_APP_ID, secret: vars.META_FACEBOOK_APP_SECRET, token: vars.META_FACEBOOK_USER_ACCESS_TOKEN, version: vars.META_API_VERSION, businessId: vars.META_FACEBOOK_BUSINESS_ID }, expectedUsername);
    if (process.argv.includes('--check')) { console.log('Class account, permissions, publishing access and music catalog verified. No connection was changed.'); return; }
    const ciphertext = await encryptConnection(vars.MEDIA_URL_SECRET, connection);
    if (!/^[A-Za-z0-9_.-]*$/.test(oldValue)) throw new SetupError('Invalid saved connection format.');
    const result = await execute(`INSERT OR REPLACE INTO app_settings(key,value) SELECT 'meta_facebook_connection','${ciphertext}' WHERE NOT EXISTS (SELECT 1 FROM publications WHERE status IN ('queued','publishing')) AND COALESCE((SELECT value FROM app_settings WHERE key='meta_facebook_connection'),'')='${oldValue}';`);
    if (result[0]?.meta?.changes !== 1) throw new SetupError('Publishing is active or the connection changed during setup. Wait, then retry. No connection was replaced.');
    const saved = await execute("SELECT value FROM app_settings WHERE key='meta_facebook_connection';");
    if (saved[0]?.results[0]?.value !== ciphertext) throw new SetupError('Connection verification after saving failed. Inspect setup before publishing.');
    console.log(`Instagram catalog music connected for the existing class account. Reconnect before ${new Date(connection.expiresAt * 1000).toISOString().slice(0, 10)}. No posts were created or deleted.`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { // Do not print errors from fetch/crypto/CLI that may contain sensitive input.
    process.exitCode = 1;
    console.error(error instanceof SetupError ? error.message : 'Setup did not finish. Check credentials and network access. No secret values were printed.');
  });
}
