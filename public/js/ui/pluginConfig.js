// ui/pluginConfig.js — the host's remembered 插件 panel choice (the room plugin ids + their manifest settings), so a
// player who hosts rooms does not have to re-enable and re-tune the same plugins on every device / every room.
//
// What is remembered is only the CHOICE, not a live room: `[{ id, settings? }]` in the same shape `room.setPlugins`
// takes. Applying it still goes through the normal `room.setPlugins` validation (the server's plugin policy, missing
// plugins, a running match), so a remembered choice that is no longer available is refused instead of forced into a
// room. The room's live set and its hashes are never part of this store.
//
// It lives in `sp.pref.roomPlugins` locally (a guest / offline room creation still works) and in the account's settings
// document (`plugins.room`) when signed in (ui/settingsSync.js). `installPluginConfigSync` applies the remembered list
// once to a freshly created room this player hosts and whose room has no plugins yet; a host's later edits in the
// panel update the store through `rememberRoomPlugins`.

import { createStore, loadPref, savePref, store } from '../store.js';
import { sanitizeRoomPlugins } from '../../../shared/settingsSync.js';

/** localStorage preference (`sp.pref.roomPlugins`) of the remembered host plugin choice. */
export const ROOM_PLUGIN_PREF = 'roomPlugins';

/** The remembered `[{ id, settings? }]` list, sanitised on load. */
export const savedRoomPlugins = createStore({
  list: sanitizeRoomPlugins(loadPref(ROOM_PLUGIN_PREF, [])) || [],
});
savedRoomPlugins.subscribe((s) => savePref(ROOM_PLUGIN_PREF, s.list));

/**
 * Remember a host's 插件 panel choice (called by ui/pluginPanel.js after the server accepted it). Invalid entries are
 * dropped; an empty list forgets the configuration.
 * @param {unknown} list `[{ id, settings? }]`
 */
export function rememberRoomPlugins(list) {
  const clean = sanitizeRoomPlugins(list) || [];
  savedRoomPlugins.set({ list: clean });
}

/**
 * Apply the remembered choice to a room this browser hosts, once, when that room has no plugins yet. The request is
 * the ordinary `room.setPlugins` (a host-only, LOBBY-only frame); a refusal (a missing plugin, a running match) is
 * logged and not retried for that room.
 * @param {{ net: any }} deps
 * @returns {{ dispose: () => void }}
 */
export function installPluginConfigSync({ net } = {}) {
  /** Room code whose remembered list was already sent (null: nothing to apply in the current room). */
  let appliedRoom = null;
  let inFlight = false;

  const roomOf = () => {
    const s = store.get();
    const room = s.room;
    const me = s.me?.playerId;
    if (!room || me == null || room.hostId !== me || room.inMatch) return null;
    // A room that already carries plugins (an applied choice, a restored room, another set) is not overwritten.
    if (Array.isArray(room.content?.plugins) && room.content.plugins.length) return null;
    return room;
  };

  const apply = async () => {
    if (inFlight) return;
    const room = roomOf();
    if (!room) return;
    const code = room.code || 'solo';
    if (code === appliedRoom) return;
    const list = savedRoomPlugins.get().list;
    if (!list.length) return;
    inFlight = true;
    appliedRoom = code;
    try {
      await net.request('room.setPlugins', { plugins: list });
    } catch (err) {
      // a plugin this server no longer offers / a policy refusal: the host can still pick by hand in the panel
      console.warn('[plugins] remembered room configuration not applied', err?.code || err?.detail || err);
    } finally {
      inFlight = false;
    }
  };

  const offState = net.on?.('room.state', () => { void apply(); }) || (() => {});
  const offClosed = net.on?.('room.closed', () => { appliedRoom = null; }) || (() => {});
  const offList = savedRoomPlugins.subscribe(() => { void apply(); });

  return { dispose() { offState(); offClosed(); offList(); } };
}
