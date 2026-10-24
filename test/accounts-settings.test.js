// test/accounts-settings.test.js — the account's settings document (extension §account, shared/settingsSync.js).
//
// What is asserted:
//   * the document round-trips through the wire (settings.push → settings.pull), survives a reopen of accounts.db and
//     travels in auth.login's reply, so a second device applies it before its first render;
//   * a 游客's frames stay no-ops and an invalid document is refused with BAD_MSG;
//   * the SQLite store migrates a legacy accounts.json in one transaction, keeps its backup, and never quietly
//     replaces a corrupt one with an empty store;
//   * an unused store creates no file, and a closed store releases the temp directory (Windows).
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { AccountStore } from '../server/accounts.js';
import { accountsDirFrom, DEFAULT_ACCOUNTS_DIR } from '../server/http/config.js';
import { normalizeSettingsDoc, SETTINGS_SYNC_VERSION } from '../shared/settingsSync.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';

const noopLog = { info() {}, warn() {}, debug() {}, error() {} };
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

const SKIN_OP = 'char_498_inside';
const SKIN_ID = 'char_498_inside@kitchen#2';

const doc = (game = { bgm: 0.4, textSize: 'lg' }, cosmetic = ['skin-a'], ui = ['tally'], room = []) => ({
  v: SETTINGS_SYNC_VERSION,
  game,
  plugins: { cosmetic, ui, room },
});

/** Settle when an async predicate holds (DB writes from room.skins are fire-and-forget). */
function waitFor(pred, ms = 3000, what = 'condition') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = async () => {
      let ok;
      try { ok = await pred(); } catch { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout waiting for ${what}`));
      setTimeout(tick, 20);
    };
    void tick();
  });
}

function clientPool(getUrl) {
  const open = new Set();
  return {
    async connect() {
      const c = await TestClient.connect(getUrl());
      open.add(c);
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}

describe('shared/settingsSync.js: the document shape', () => {
  test('accepts this build\'s envelope and normalises plugin id lists', () => {
    const clean = normalizeSettingsDoc(doc({ bgm: 0.2 }, ['b-skin', 'a-skin', 'b-skin'], ['tally', 'meter']));
    assert.deepEqual(clean.plugins, { cosmetic: ['a-skin', 'b-skin'], ui: ['meter', 'tally'], room: [] });
    assert.equal(clean.v, SETTINGS_SYNC_VERSION);
  });

  test('refuses a foreign version, a non-object game, an invalid id or a huge document', () => {
    assert.equal(normalizeSettingsDoc({ ...doc(), v: SETTINGS_SYNC_VERSION + 1 }), null);
    assert.equal(normalizeSettingsDoc({ ...doc(), game: [] }), null);
    assert.equal(normalizeSettingsDoc({ ...doc(), plugins: [] }), null);
    assert.equal(normalizeSettingsDoc(doc({}, ['Bad Id'])), null);
    assert.equal(normalizeSettingsDoc(doc({ pad: 'x'.repeat(60_000) })), null);
    // absent lists mean "none switched on", not a refusal
    assert.deepEqual(normalizeSettingsDoc({ v: SETTINGS_SYNC_VERSION, game: {}, plugins: {} }).plugins, { cosmetic: [], ui: [], room: [] });
  });

  test('the remembered room-plugin configuration: valid ids / scalar settings, bounded and sorted', () => {
    const clean = normalizeSettingsDoc(doc({}, [], [], [
      { id: 'zeta', settings: { refresh: 2, enabled: true, label: 'x' } },
      { id: 'alpha' },
      { id: 'zeta', settings: { refresh: 3 } }, // last wins
    ]));
    assert.deepEqual(clean.plugins.room, [
      { id: 'alpha' },
      { id: 'zeta', settings: { refresh: 3 } },
    ]);
    assert.equal(normalizeSettingsDoc(doc({}, [], [], [{ id: 'Bad Id' }])), null);
    assert.equal(normalizeSettingsDoc(doc({}, [], [], [{ id: 'alpha', settings: [] }])), null);
    assert.equal(normalizeSettingsDoc(doc({}, [], [], [{ id: 'alpha', settings: { x: null } }])), null);
    assert.equal(normalizeSettingsDoc(doc({}, [], [], [{ id: 'alpha', settings: JSON.parse('{"__proto__":1}') }])), null);
    assert.equal(normalizeSettingsDoc(doc({}, [], [], Array.from({ length: 33 }, (_, i) => ({ id: `p-${i}` })))), null);
  });
});

describe('accounts: the settings document over the wire', () => {
  let srv;
  let tmp;
  let pool;

  before(async () => {
    tmp = tmpDir('sp-settings-');
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accounts: new AccountStore({ dir: tmp, log: noopLog }), helloTimeoutMs: 10_000 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function signedIn(username) {
    const c = await pool.connect();
    const reg = await c.request({ t: 'auth.register', username, password: 'pw1234' }, 10_000);
    assert.equal(reg.t, 'auth.result', JSON.stringify(reg));
    const w = await c.hello(undefined, null, { account: reg.token });
    assert.equal(w.name, username);
    assert.equal(w.accountId, reg.accountId);
    return { client: c, token: reg.token, accountId: reg.accountId };
  }

  test('push → pull → reopen: the document is stored and the account stamps it', async () => {
    const { client, token } = await signedIn('SettingsA');
    const empty = await client.request({ t: 'settings.pull' });
    assert.equal(empty.t, 'settings.sync', JSON.stringify(empty));
    assert.equal(empty.settings, null, 'a new account has no document yet');

    assert.equal((await client.request({ t: 'settings.push', settings: doc() })).t, 'ok');
    const pulled = await client.request({ t: 'settings.pull' });
    assert.equal(pulled.t, 'settings.sync');
    assert.deepEqual(pulled.settings, doc());
    assert.ok(Number.isFinite(pulled.updatedAt));

    // a second connection reads the committed row (the database, not a process-local cache)
    const reopened = new AccountStore({ dir: tmp, log: noopLog });
    try {
      const read = await reopened.readSettings(token);
      assert.deepEqual(read.settings, doc());
      assert.ok(Number.isFinite(read.updatedAt));
    } finally {
      reopened.close();
    }
  });

  test('auth.login carries the account document (a second device applies it before entering)', async () => {
    const { client, accountId } = await signedIn('SettingsB');
    await client.request({ t: 'settings.push', settings: doc({ muted: true, quality: 'low' }, ['skin-b'], []) });

    // no hello: the login reply must already carry the document (a hello would take this account's seat over)
    const second = await pool.connect();
    const login = await second.request({ t: 'auth.login', accountId, password: 'pw1234' }, 10_000);
    assert.equal(login.t, 'auth.result', JSON.stringify(login));
    assert.deepEqual(login.settings, doc({ muted: true, quality: 'low' }, ['skin-b'], []));
    assert.ok(Number.isFinite(login.settingsUpdatedAt));
  });

  test('auth.rename changes the display username but not the account ID / bearer', async () => {
    const { client, token, accountId } = await signedIn('OldName');
    const r = await client.request({ t: 'auth.rename', username: '新名字' }, 10_000);
    assert.equal(r.t, 'auth.result', JSON.stringify(r));
    assert.equal(r.accountId, accountId);
    assert.equal(r.token, token);
    assert.equal(r.username, '新名字');

    // the account ID still signs in, and the new display name comes back
    const second = await pool.connect();
    const login = await second.request({ t: 'auth.login', accountId, password: 'pw1234' }, 10_000);
    assert.equal(login.t, 'auth.result', JSON.stringify(login));
    assert.equal(login.username, '新名字');
  });

  test('auth.rename updates the room seat and the running match at any time', async () => {
    const { client } = await signedIn('RenameSeat');
    assert.equal((await client.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' })).t, 'ok');
    const before = await client.waitFor('room.state');
    assert.equal(before.seats[0].name, 'RenameSeat');

    const renamed = await client.request({ t: 'auth.rename', username: '房间里的新名字' }, 10_000);
    assert.equal(renamed.t, 'auth.result', JSON.stringify(renamed));
    const state = await client.waitFor('room.state', (s) => s.seats[0]?.name === '房间里的新名字');
    assert.equal(state.seats[0].name, '房间里的新名字');

    assert.equal((await client.request({ t: 'room.start' })).t, 'ok');
    await client.waitFor('m.public', (p) => p.players?.some((x) => x.name === '房间里的新名字'));
    const during = await client.request({ t: 'auth.rename', username: '对局中的新名字' }, 10_000);
    assert.equal(during.t, 'auth.result', JSON.stringify(during));
    const pub = await client.waitFor('m.public', (p) => p.players?.some((x) => x.name === '对局中的新名字'));
    assert.ok(pub.players.some((x) => x.name === '对局中的新名字'), 'm.public carries the match copy of the name');
  });

  test('room.skins is stored on the account and comes back through auth.login / welcome', async () => {
    const { client, token, accountId } = await signedIn('SkinSync');
    assert.equal((await client.request({ t: 'room.skins', skins: { [SKIN_OP]: SKIN_ID } })).t, 'ok');
    await waitFor(async () => (await srv.accounts.readSkins(token))?.[SKIN_OP] === SKIN_ID, 3000, 'the account skin copy');

    const second = await pool.connect();
    const login = await second.request({ t: 'auth.login', accountId, password: 'pw1234' }, 10_000);
    assert.deepEqual(login.skins, { [SKIN_OP]: SKIN_ID }, 'auth.result carries the skin choice');
    const welcome = await second.hello(undefined, null, { account: login.token });
    assert.deepEqual(welcome.accountSkins, { [SKIN_OP]: SKIN_ID }, 'welcome carries the account copy');

    // an explicit empty choice is different from "no copy": it clears the account's selection
    await second.request({ t: 'room.skins', skins: {} });
    await waitFor(async () => Object.keys((await srv.accounts.readSkins(token)) || { x: 1 }).length === 0, 3000, 'the cleared copy');
    const again = await pool.connect();
    const login2 = await again.request({ t: 'auth.login', accountId, password: 'pw1234' }, 10_000);
    assert.deepEqual(login2.skins, {}, 'an explicitly cleared selection is retained');
  });

  test('a 游客 push/pull is a silent no-op, and an invalid document is BAD_MSG', async () => {
    const guest = await pool.connect();
    await guest.hello('游客乙');
    assert.equal((await guest.request({ t: 'settings.push', settings: doc() })).t, 'ok');
    const pulled = await guest.request({ t: 'settings.pull' });
    assert.equal(pulled.t, 'ok', 'a plain ok: there is no account here');
    assert.equal(pulled.settings, undefined);

    const { client } = await signedIn('SettingsC');
    for (const settings of [{ ...doc(), v: SETTINGS_SYNC_VERSION + 1 }, doc({}, ['not a plugin id']), { game: {} }, null]) {
      const r = await client.request({ t: 'settings.push', settings });
      assert.equal(r.t, 'error', JSON.stringify(settings).slice(0, 100));
      assert.equal(r.code, ERR.BAD_MSG);
    }
    assert.equal((await client.request({ t: 'settings.pull' })).settings, null, 'nothing was stored by the refusals');
  });

  test('the last writer wins (the account is one document, not a merge)', async () => {
    const { client } = await signedIn('SettingsD');
    await client.request({ t: 'settings.push', settings: doc({ bgm: 0.1 }) });
    await client.request({ t: 'settings.push', settings: doc({ bgm: 0.9 }) });
    assert.deepEqual((await client.request({ t: 'settings.pull' })).settings.game, { bgm: 0.9 });
  });

  test('the remembered room-plugin configuration round-trips with its settings', async () => {
    const { client } = await signedIn('SettingsRoom');
    const room = [{ id: 'tally', settings: { refresh: 2, enabled: true, label: 'compact' } }];
    assert.equal((await client.request({ t: 'settings.push', settings: doc({}, [], [], room) })).t, 'ok');
    const pulled = await client.request({ t: 'settings.pull' });
    assert.deepEqual(pulled.settings.plugins.room, room);
  });
});

describe('AccountStore: SQLite storage and the accounts.json migration', () => {
  /** @type {AccountStore[]} */
  let open;
  /** @type {string[]} */
  let dirs;
  const store = (dir) => { const s = new AccountStore({ dir, log: noopLog }); open.push(s); return s; };
  const temp = (prefix) => { const dir = tmpDir(prefix); dirs.push(dir); return dir; };
  before(() => { open = []; dirs = []; });
  after(() => {
    for (const s of open) s.close();
    for (const dir of dirs) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  test('a test process never falls back to the operator\'s real account directory', () => {
    // node --test sets NODE_TEST_CONTEXT; without an explicit accountsDir the store moves to a per-process temp dir.
    const dir = accountsDirFrom({});
    assert.notEqual(dir, DEFAULT_ACCOUNTS_DIR);
    assert.match(dir, /sp-accounts-test/);
  });

  test('an unused store creates no file; the first account creates the database', async () => {
    const dir = temp('sp-db-idle-');
    const idle = store(dir);
    await idle.load();
    assert.equal(fs.existsSync(path.join(dir, 'accounts.db')), false, 'reading nothing leaves nothing behind');
    await idle.register('Idle', 'pw1234');
    assert.equal(fs.existsSync(path.join(dir, 'accounts.db')), true);
  });

  test('skins: null is "never saved", an empty selection is `{}`, and both survive a reopen', async () => {
    const dir = temp('sp-db-skins-');
    const s = store(dir);
    const reg = await s.register('SkinStore', 'pw1234');
    assert.equal(await s.readSkins(reg.token), null, 'a new account has no skin copy');
    const empty = await s.saveSkins(reg.token, {});
    assert.deepEqual(empty, {});
    assert.deepEqual(await s.readSkins(reg.token), {}, 'an explicitly empty selection is stored');
    assert.deepEqual(await s.saveSkins(reg.token, { [SKIN_OP]: SKIN_ID }), { [SKIN_OP]: SKIN_ID });
    assert.deepEqual((await s.resolveToken(reg.token)).skins, { [SKIN_OP]: SKIN_ID });

    const again = store(dir);
    assert.deepEqual(await again.readSkins(reg.token), { [SKIN_OP]: SKIN_ID }, 'persisted');
  });

  test('a legacy accounts.json is imported once, kept as .imported, and its token still works', async () => {
    const dir = temp('sp-db-import-');
    const token = 'a'.repeat(64);
    const legacy = {
      Legacy: {
        name: 'Legacy', salt: '00', hash: '00', token,
        loadout: { chess_char_1_01_a: { skill: 0, module: 'm' } },
        ops: { char_1: { potential: 4, cultivate: 2 } },
        stats: { v: 2, records: [{ id: 'r1', t: 10 }, { id: 'r2', t: 20 }] },
        statsClearedAt: 5, createdAt: 100, lastLoginAt: 200, futureField: { keep: true },
      },
    };
    fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify(legacy));
    const s = store(dir);
    await s.load();
    const acct = s.lookupToken(token);
    assert.ok(acct, 'the old bearer resolves');
    assert.equal(acct.username, 'Legacy');
    assert.deepEqual(acct.loadout, { chess_char_1_01_a: { skill: 0, module: 'm' } });
    assert.deepEqual(acct.ops, { char_1: { potential: 4, cultivate: 2 } });
    assert.deepEqual(acct.stats.records.map((r) => r.id), ['r2', 'r1']);
    assert.equal(acct.statsClearedAt, 5);
    const raw = s._readAccount('legacy');
    assert.equal(raw.createdAt, 100);
    assert.equal(raw.lastLoginAt, 200);
    assert.deepEqual(raw.futureField, { keep: true }, 'unknown fields survive in extra_json');
    assert.equal(fs.existsSync(path.join(dir, 'accounts.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'accounts.json.imported')), true);

    // a second open does not import again (the database already has the account)
    const again = store(dir);
    await again.load();
    assert.equal(again._accountCount(), 1);
  });

  test('a corrupt accounts.json disables the store instead of starting empty', async () => {
    const dir = temp('sp-db-corrupt-');
    fs.writeFileSync(path.join(dir, 'accounts.json'), '{ broken');
    const s = store(dir);
    await assert.rejects(() => s.load(), /accounts\.json is not valid JSON/);
    assert.equal(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'), '{ broken', 'the original file is untouched');
    assert.equal(s.db, null);
  });
});
