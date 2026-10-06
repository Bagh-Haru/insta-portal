import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFacebook, encryptConnection, decryptConnection, databaseExecutor } from './meta-setup.mjs';
const config = { appId: '123456789', secret: 'test-app-secret', token: 'short-token' };
const permissions = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement'];
function provider(overrides = {}) {
  const calls = [];
  const request = async (value, options) => {
    const url = new URL(value); calls.push({ url, options }); const endpoint = url.pathname.slice('/v26.0/'.length);
    const bodies = {
      'oauth/access_token': { access_token: 'long-token', expires_in: 60 * 86400 },
      'debug_token': { data: { is_valid: true, app_id: config.appId, type: 'USER', scopes: permissions, expires_at: Math.floor(Date.now()/1000) + 50 * 86400 } },
      'me/accounts': { data: [{ instagram_business_account: { id: '17840000000001', username: 'class_account' } }] },
      '17840000000001/content_publishing_limit': { data: [{ quota_usage: 0 }] },
      'ig_audio': { audio: [{ audio_id: '123', title: 'Track' }] },
      ...overrides,
    };
    return Response.json(bodies[endpoint] ?? { error: { message: 'Private provider diagnostics' } });
  };
  return { request, calls };
}
test('exchanges and verifies permissions, class identity, publishing and music without publishing', async () => {
  const fake = provider(); const connection = await verifyFacebook(config, 'CLASS_ACCOUNT', fake.request);
  assert.equal(connection.token, 'long-token'); assert.equal(connection.userId, '17840000000001'); assert.equal(connection.username, 'class_account');
  assert.ok(connection.expiresAt < connection.verifiedAt + 60 * 86400);
  assert.equal(fake.calls.length, 5); assert.ok(fake.calls.every(c => !c.url.pathname.endsWith('/media_publish') && !c.url.pathname.endsWith('/media')));
  assert.equal(fake.calls.find(c => c.url.pathname.endsWith('/me/accounts')).options.headers.Authorization, 'Bearer long-token');
});
test('rejects a token from another app, a Page token, or missing permissions', async () => {
  for (const change of [{ app_id: 'different-app' }, { type: 'PAGE' }, { scopes: permissions.slice(1) }, { is_valid: false }]) {
    const fake = provider({ debug_token: { data: { is_valid: true, app_id: config.appId, type: 'USER', scopes: permissions, ...change } } });
    await assert.rejects(verifyFacebook(config, 'class_account', fake.request), /valid Facebook USER token/);
    assert.equal(fake.calls.length, 2);
  }
});
test('rejects another Instagram account and never probes or saves it', async () => {
  const fake = provider({ 'me/accounts': { data: [{ instagram_business_account: { id: '99', username: 'another_account' } }] } });
  await assert.rejects(verifyFacebook(config, 'class_account', fake.request), /existing class Instagram account/); assert.equal(fake.calls.length, 3);
});
test('rejects failed music access without returning a usable connection', async () => {
  const fake = provider({ ig_audio: { error: { message: 'SECRET-private-provider-response' } } });
  await assert.rejects(verifyFacebook(config, 'class_account', fake.request), error => error.message.includes('ig_audio') && !error.message.includes('SECRET'));
});
test('honors data-access expiry and rejects expired authorization', async () => {
  const fake = provider({ debug_token: { data: { is_valid: true, app_id: config.appId, type: 'USER', scopes: permissions, data_access_expires_at: 1 } } });
  await assert.rejects(verifyFacebook(config, 'class_account', fake.request), /expired/);
});
test('follows Page cursors without trusting provider next URLs', async () => {
  const fake = provider(); const request = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/me/accounts') && !parsed.searchParams.has('after')) return Response.json({ data: [], paging: { next: 'https://wrong.example/token', cursors: { after: 'cursor' } } });
    return fake.request(url, options);
  };
  assert.equal((await verifyFacebook(config, 'class_account', request)).userId, '17840000000001');
  assert.ok(fake.calls.every(c => c.url.hostname === 'graph.facebook.com'));
});
test('connection encryption is compatible and rejects tampering or a different secret', async () => {
  const connection = { token: 'PRIVATE-TOKEN', userId: '17840000000001', username: 'class' };
  const value = await encryptConnection('media-secret', connection); assert.ok(!value.includes(connection.token));
  assert.deepEqual(await decryptConnection('media-secret', value), connection);
  await assert.rejects(decryptConnection('another-secret', value));
  const [iv, cipher] = value.split('.'); const altered = Buffer.from(cipher, 'base64url'); altered[0] ^= 1;
  await assert.rejects(decryptConnection('media-secret', iv + '.' + altered.toString('base64url')));
});

test('database reads execute SQL queries and return their rows rather than file-import summaries', async () => {
  const calls = [];
  const execute = databaseExecutor('test-account', (binary, args, options) => {
    calls.push({ args, options });
    return JSON.stringify([{ success: true, results: [{ value: 'encrypted-connection' }], meta: { changes: 0 } }]);
  });
  const result = await execute("SELECT value FROM app_settings WHERE key='meta_facebook_connection';");
  assert.equal(result[0].results[0].value, 'encrypted-connection');
  assert.ok(calls[0].args.includes('--command')); assert.ok(!calls[0].args.includes('--file'));
  assert.equal(calls[0].options.env.CLOUDFLARE_ACCOUNT_ID, 'test-account');
});
test('explains an empty Page grant without switching accounts', async () => {
  const fake = provider({ 'me/accounts': { data: [] } });
  await assert.rejects(verifyFacebook(config, 'class_account', fake.request), /no accessible Pages/);
  assert.equal(fake.calls.length, 3);
});

test('expired Facebook tokens produce an actionable message without leaking provider diagnostics', async () => {
  const fake = provider({ 'oauth/access_token': { error: { code: 190, error_subcode: 463, message: 'PRIVATE-TOKEN-provider-details' } } });
  await assert.rejects(verifyFacebook(config, 'class_account', fake.request), error => error.message.includes('token expired') && error.message.includes('META_FACEBOOK_USER_ACCESS_TOKEN') && !error.message.includes('PRIVATE-TOKEN'));
  assert.equal(fake.calls.length, 1);
});

test('discovers the class account through the configured business portfolio when me/accounts is empty', async () => {
  const fake = provider({
    'me/accounts': { data: [] },
    'debug_token': { data: { is_valid: true, app_id: config.appId, type: 'USER', scopes: [...permissions, 'business_management'] } },
    '1375747930697653/owned_pages': { data: [{ instagram_business_account: { id: '17840000000001', username: 'class_account' } }] },
  });
  const connected = await verifyFacebook({ ...config, businessId: '1375747930697653' }, 'class_account', fake.request);
  assert.equal(connected.userId, '17840000000001'); assert.ok(fake.calls.some(c => c.url.pathname.endsWith('/owned_pages')));
});
test('requires business_management only when portfolio discovery is needed', async () => {
  const fake = provider({ 'me/accounts': { data: [] } });
  await assert.rejects(verifyFacebook({ ...config, businessId: '1375747930697653' }, 'class_account', fake.request), /Add business_management/);
  assert.equal(fake.calls.length, 3);
  const direct = provider(); assert.equal((await verifyFacebook({ ...config, businessId: '1375747930697653' }, 'class_account', direct.request)).userId, '17840000000001');
  assert.ok(!direct.calls.some(c => c.url.pathname.endsWith('/owned_pages')));
});
test('does not accept a different account returned by the business portfolio', async () => {
  const fake = provider({
    'me/accounts': { data: [] },
    'debug_token': { data: { is_valid: true, app_id: config.appId, type: 'USER', scopes: [...permissions, 'business_management'] } },
    '1375747930697653/owned_pages': { data: [{ instagram_business_account: { id: '99', username: 'other_account' } }] },
  });
  await assert.rejects(verifyFacebook({ ...config, businessId: '1375747930697653' }, 'class_account', fake.request), /existing class Instagram account/);
});
