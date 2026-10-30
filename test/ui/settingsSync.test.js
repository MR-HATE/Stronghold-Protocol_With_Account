// test/ui/settingsSync.test.js — the client half of the account's settings document (ui/settingsSync.js).
//
// The real stores are singletons with browser side effects, so these tests inject small stores and a fake socket. What
// matters is the direction: an account copy is applied on pull (game settings + both plugin switch lists), a local edit
// is pushed as one document, and a 游客 sends nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ui/settings.js touches localStorage at import time; keep the module import browser-safe.
globalThis.localStorage = globalThis.localStorage || {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};

const { createStore } = await import('../../public/js/store.js');
const { buildSettingsDoc, applyAccountSettings, installSettingsSync } = await import('../../public/js/ui/settingsSync.js');
const { SETTINGS_SYNC_VERSION } = await import('../../shared/settingsSync.js');

function stores(initial = {}) {
  return {
    settings: createStore({ bgm: 0.5, sfx: 0.5, voice: 0.5, voiceLang: 'cn', voiceNative: false, voiceOverrides: {},
      muted: false, damageNumbers: true, officialDamageNumbers: false, ammoEnergyCount: false, combatMetrics: false,
      prepDeployFold: true, quality: 'high', officialFx: 'auto', otherSkins: true, textSize: 'sm', keys: {},
      ...initial }),
    personal: createStore({ ids: ['skin-b', 'skin-a'] }),
    ui: createStore({ ids: ['tally'] }),
    room: createStore({ list: [{ id: 'room-a', settings: { refresh: 1 } }] }),
    media: createStore({ prefs: { backdrop: false, music: false, dim: 0.35, scene: 'official' }, backdrop: null, music: null, busy: null }),
  };
}

function fakeNet(reply = null) {
  return {
    status: 'online',
    calls: [],
    on() { return () => {}; },
    async request(t, payload) {
      this.calls.push({ t, payload });
      if (reply) return reply(t, payload);
      return { t: 'ok' };
    },
  };
}

test('buildSettingsDoc carries the sanitised settings, sorted plugin ids and lobbyMedia prefs', () => {
  const s = stores();
  const doc = buildSettingsDoc(s);
  assert.equal(doc.v, SETTINGS_SYNC_VERSION);
  assert.equal(doc.game.bgm, 0.5);
  assert.deepEqual(doc.plugins, {
    cosmetic: ['skin-a', 'skin-b'], ui: ['tally'],
    room: [{ id: 'room-a', settings: { refresh: 1 } }],
  });
  assert.deepEqual(doc.lobbyMedia, { backdrop: false, music: false, dim: 0.35, scene: 'official' });
});

test('applyAccountSettings replaces the settings, switch lists and lobbyMedia prefs', () => {
  const s = stores({ bgm: 0.1 });
  const applied = applyAccountSettings({
    v: SETTINGS_SYNC_VERSION,
    game: { bgm: 0.9, textSize: 'xl' },
    plugins: { cosmetic: ['z-skin'], ui: ['a-ui', 'b-ui'], room: [{ id: 'from-account', settings: { mode: 2 } }] },
    lobbyMedia: { backdrop: true, music: false, dim: 0.6, scene: 'ember' },
  }, s);
  assert.deepEqual(applied.plugins, {
    cosmetic: ['z-skin'], ui: ['a-ui', 'b-ui'],
    room: [{ id: 'from-account', settings: { mode: 2 } }],
  });
  assert.deepEqual(applied.lobbyMedia, { backdrop: true, music: false, dim: 0.6, scene: 'ember' });
  assert.equal(s.settings.get().bgm, 0.9);
  assert.equal(s.settings.get().textSize, 'xl');
  assert.deepEqual(s.personal.get().ids, ['z-skin']);
  assert.deepEqual(s.ui.get().ids, ['a-ui', 'b-ui']);
  assert.deepEqual(s.room.get().list, [{ id: 'from-account', settings: { mode: 2 } }]);
  assert.deepEqual(s.media.get().prefs, { backdrop: true, music: false, dim: 0.6, scene: 'ember' });
  assert.equal(applyAccountSettings({ v: 99, game: {}, plugins: {} }, s), null, 'a foreign document changes nothing');

  // an account document from before the room-plugin / lobbyMedia fields existed keeps this browser's local choices
  const before = stores();
  before.media.set({ prefs: { backdrop: false, music: true, dim: 0.5, scene: 'night' } });
  applyAccountSettings({ v: SETTINGS_SYNC_VERSION, game: {}, plugins: { cosmetic: [], ui: [] } }, before);
  assert.deepEqual(before.room.get().list, [{ id: 'room-a', settings: { refresh: 1 } }]);
  assert.deepEqual(before.media.get().prefs, { backdrop: false, music: true, dim: 0.5, scene: 'night' });
});

test('pull applies the account copy; a local edit pushes one document; a 游客 sends nothing', async () => {
  const s = stores();
  const accountDoc = {
    v: SETTINGS_SYNC_VERSION,
    game: { bgm: 0.8 },
    plugins: { cosmetic: ['from-account'], ui: [], room: [{ id: 'account-room' }] },
    lobbyMedia: { backdrop: false, music: true, dim: 0.4, scene: 'frost' },
  };
  const net = fakeNet((t) => (t === 'settings.pull' ? { t: 'settings.sync', settings: accountDoc, updatedAt: 7 } : { t: 'ok' }));
  let account = { token: 'a'.repeat(64) };
  const sync = installSettingsSync({ net, getAccount: () => account, stores: s });
  try {
    await sync.pull();
    assert.deepEqual(net.calls.map((c) => c.t), ['settings.pull']);
    assert.equal(s.settings.get().bgm, 0.8, 'the account copy is local after a pull');
    assert.deepEqual(s.personal.get().ids, ['from-account']);
    assert.deepEqual(s.room.get().list, [{ id: 'account-room' }]);
    assert.deepEqual(s.media.get().prefs, { backdrop: false, music: true, dim: 0.4, scene: 'frost' });

    // a local edit is one whole-document push
    s.settings.set({ ...s.settings.get(), bgm: 0.2 });
    await sync.push();
    const push = net.calls.find((c) => c.t === 'settings.push');
    assert.ok(push, 'the edit was pushed');
    assert.equal(push.payload.settings.game.bgm, 0.2);
    assert.deepEqual(push.payload.settings.plugins.cosmetic, ['from-account']);
    assert.deepEqual(push.payload.settings.plugins.room, [{ id: 'account-room' }]);
    assert.deepEqual(push.payload.settings.lobbyMedia, { backdrop: false, music: true, dim: 0.4, scene: 'frost' });

    // a 游客 (no account token) sends nothing
    account = null;
    const before = net.calls.length;
    await sync.pull();
    await sync.push({ force: true });
    assert.equal(net.calls.length, before, 'no account, no frames');
  } finally {
    sync.dispose();
  }
});

test('a pre-room account document keeps this browser\'s host choice and is upgraded', async () => {
  const s = stores();
  const legacy = { v: SETTINGS_SYNC_VERSION, game: { bgm: 0.4 }, plugins: { cosmetic: [], ui: [] } };
  const net = fakeNet((t) => (t === 'settings.pull' ? { t: 'settings.sync', settings: legacy, updatedAt: 7 } : { t: 'ok' }));
  const sync = installSettingsSync({ net, getAccount: () => ({ token: 'c'.repeat(64) }), stores: s });
  try {
    await sync.pull();
    assert.deepEqual(s.room.get().list, [{ id: 'room-a', settings: { refresh: 1 } }], 'local host choice kept');
    const push = net.calls.find((c) => c.t === 'settings.push');
    assert.ok(push, 'the account is upgraded with the field');
    assert.deepEqual(push.payload.settings.plugins.room, [{ id: 'room-a', settings: { refresh: 1 } }]);
  } finally {
    sync.dispose();
  }
});

test('pull on an account with no document seeds it from this browser', async () => {
  const s = stores({ bgm: 0.3 });
  const net = fakeNet((t) => (t === 'settings.pull' ? { t: 'settings.sync', settings: null, updatedAt: null } : { t: 'ok' }));
  const sync = installSettingsSync({ net, getAccount: () => ({ token: 'b'.repeat(64) }), stores: s });
  try {
    await sync.pull();
    const push = net.calls.find((c) => c.t === 'settings.push');
    assert.ok(push, 'the empty account is seeded');
    assert.equal(push.payload.settings.game.bgm, 0.3);
  } finally {
    sync.dispose();
  }
});
