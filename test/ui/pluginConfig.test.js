// test/ui/pluginConfig.test.js — the host's remembered 插件 panel choice (ui/pluginConfig.js).
//
// The store persists locally and travels in the settings document (ui/settingsSync.js). The installer applies it once
// to a freshly created room this player hosts, through the ordinary room.setPlugins; it must not touch a room with
// plugins already, a match, or somebody else's room.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const backing = new Map();
globalThis.localStorage = globalThis.localStorage || {
  getItem: (k) => (backing.has(k) ? backing.get(k) : null),
  setItem: (k, v) => backing.set(k, String(v)),
  removeItem: (k) => backing.delete(k),
};

const { store } = await import('../../public/js/store.js');
const { savedRoomPlugins, rememberRoomPlugins, installPluginConfigSync } = await import('../../public/js/ui/pluginConfig.js');

function fakeNet() {
  const listeners = new Map();
  const calls = [];
  return {
    calls,
    on(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
      return () => {};
    },
    async request(t, payload) { calls.push({ t, payload }); return { t: 'ok' }; },
    emit(type, payload) { for (const fn of listeners.get(type) || []) fn(payload); },
  };
}

const room = (over = {}) => ({ code: 'ABCD', hostId: 'p1', inMatch: false, content: { vanilla: true, plugins: [] }, ...over });

test('rememberRoomPlugins sanitises, sorts and persists the list', () => {
  rememberRoomPlugins([{ id: 'zeta' }, { id: 'alpha', settings: { refresh: 2 } }]);
  assert.deepEqual(savedRoomPlugins.get().list, [
    { id: 'alpha', settings: { refresh: 2 } },
    { id: 'zeta' },
  ]);
  assert.match(backing.get('sp.pref.roomPlugins'), /alpha/);
  rememberRoomPlugins([{ id: 'Bad Id' }]);
  assert.deepEqual(savedRoomPlugins.get().list, []);
});

test('a remembered list is applied once to a hosted room with no plugins', async () => {
  rememberRoomPlugins([{ id: 'alpha', settings: { refresh: 2 } }]);
  store.set({ me: { playerId: 'p1', name: 'Host', token: null }, room: room() });
  const net = fakeNet();
  const sync = installPluginConfigSync({ net });
  try {
    net.emit('room.state', { t: 'room.state' });
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(net.calls, [{ t: 'room.setPlugins', payload: { plugins: [{ id: 'alpha', settings: { refresh: 2 } }] } }]);

    // the room.state that follows the set has plugins: no second request
    store.patch('room', { content: { vanilla: true, plugins: [{ id: 'alpha' }] } });
    net.emit('room.state', { t: 'room.state' });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(net.calls.length, 1);
  } finally {
    sync.dispose();
  }
});

test('not applied when somebody else hosts, during a match, or when plugins are already set', async () => {
  rememberRoomPlugins([{ id: 'alpha' }]);
  const net = fakeNet();
  const sync = installPluginConfigSync({ net });
  try {
    store.set({ me: { playerId: 'p1' }, room: room({ hostId: 'other' }) });
    net.emit('room.state', {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(net.calls.length, 0, 'not the host');

    store.set({ room: room({ inMatch: true }) });
    net.emit('room.state', {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(net.calls.length, 0, 'no plugin change during a match');

    store.set({ room: room({ content: { vanilla: true, plugins: [{ id: 'already' }] } }) });
    net.emit('room.state', {});
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(net.calls.length, 0, 'a room with plugins is not overwritten');
  } finally {
    sync.dispose();
  }
});
