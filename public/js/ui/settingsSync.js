// ui/settingsSync.js — the account's 设置 + personal-plugin switches (extension §account, shared/settingsSync.js).
//
// What travels is one document, owned by the client:
//
//   { v, game, plugins: { cosmetic: [id…], ui: [id…], room: [{ id, settings? }…] } }
//
// `game` is the settings store (ui/settings.js — volumes, 语音语言, 伤害数字, 画质, 文字大小, 快捷键 …), `cosmetic` the
// 外观插件 switches (content.js `personal`, `sp.pref.cosmetics`), `ui` the 界面插件 switches (ui/uiPlugins.js,
// `sp.pref.ui-plugins`) and `room` the host's remembered 插件 panel choice (ui/pluginConfig.js, `sp.pref.roomPlugins`:
// the plugin ids + their manifest settings, the same list `room.setPlugins` takes). The room's live set / hashes are
// NOT included; a remembered choice is applied through the ordinary room.setPlugins validation. A ui plugin's own
// `sp.plugin.<id>.` storage is not included either — it is the plugin's private state, not a setting this build
// defines (docs/PLUGINS.md §14).
//
// Direction (the same contract as the 干员调配, but whole-document):
//   * after every `welcome` pull the account's copy and APPLY it if there is one — the account is authoritative
//     across devices, so signing in on a new browser brings that player's settings back. An account that has never
//     stored a document is seeded from this browser (the first sign-in case);
//   * after a local edit, push the whole document (debounced). The push follows the apply, so applying the account's
//     copy never uploads what it just replaced.
// A 游客 never sends: without an account token the sync is a no-op, and the server ignores the frames anyway. Local
// settings are not cleared on logout — they are this browser's preferences until the next account's copy replaces
// them on sign-in.
//
// Dependencies are injectable like ui/statsSync.js: no import of the net.js singleton, so this module is Node-testable
// with a fake socket. The stores default to the app's own singletons.

import { settingsStore } from './settings.js';
import { personal } from '../content.js';
import { uiPlugins } from './uiPlugins.js';
import { savedRoomPlugins } from './pluginConfig.js';
import { sanitizeSettings } from './gameLogic.js';
import { SETTINGS_SYNC_VERSION, isSettingsPluginId, normalizeSettingsDoc, SETTINGS_MAX_PLUGIN_IDS } from '../../../shared/settingsSync.js';
import { UI_LIMITS } from '../../../shared/plugins/ui.js';

/** Wait this long after a settings / plugin-switch edit before pushing (a volume slider fires many times). */
export const SETTINGS_PUSH_DEBOUNCE_MS = 1000;
/** Wait this long after `welcome` before pulling (the session is online; room / stats frames go first). */
export const SETTINGS_PULL_DEBOUNCE_MS = 150;
/** Retry delay after an OFFLINE / RATE / TIMEOUT refusal. */
const RETRY_MS = 15_000;

const defaultTimers = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };

/** Nonzero while an account copy is being applied: the stores' own subscribers must not upload it back. */
let applying = 0;

/** @param {unknown} ids @param {number} max @returns {string[]} valid, unique, sorted ids (at most `max`) */
function cleanIds(ids, max) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!isSettingsPluginId(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= max) break;
  }
  return out.sort();
}

/**
 * The document this browser would upload: the current settings and plugin switches, sanitised exactly like the
 * store persists them. Null when the local state cannot form a document (never for a store this build wrote).
 * @param {{ settings?: any, personal?: any, ui?: any, room?: any }} [stores]
 * @returns {{ v: number, game: Record<string, any>, plugins: { cosmetic: string[], ui: string[], room: { id: string, settings?: object }[] } } | null}
 */
export function buildSettingsDoc({ settings = settingsStore, personal: personalStore = personal, ui: uiStore = uiPlugins, room: roomStore = savedRoomPlugins } = {}) {
  return normalizeSettingsDoc({
    v: SETTINGS_SYNC_VERSION,
    game: sanitizeSettings(settings.get()),
    plugins: {
      cosmetic: cleanIds(personalStore.get().ids, SETTINGS_MAX_PLUGIN_IDS),
      ui: cleanIds(uiStore.get().ids, UI_LIMITS.maxPlugins),
      room: roomStore.get().list,
    },
  });
}

/**
 * Apply the account's document to this browser: the game settings (replacing the local values) and the two plugin
 * switch lists. Idempotent; a malformed document changes nothing and returns null.
 * @param {any} doc `settings`, `games`, `plugins` from `auth.result` / `settings.sync`
 * @param {{ settings?: any, personal?: any, ui?: any, room?: any }} [stores]
 * @returns {{ v: number, game: Record<string, any>, plugins: { cosmetic: string[], ui: string[], room: { id: string, settings?: object }[] } } | null}
 */
export function applyAccountSettings(doc, { settings = settingsStore, personal: personalStore = personal, ui: uiStore = uiPlugins, room: roomStore = savedRoomPlugins } = {}) {
  const clean = normalizeSettingsDoc(doc);
  if (!clean) return null;
  // An older account document has no `plugins.room` field: keep this browser's local host choice and let the next
  // push upgrade the account, instead of treating "field not known then" as "the host has no remembered choice".
  const hasRoom = !!doc && typeof doc === 'object' && !!doc.plugins && Object.hasOwn(doc.plugins, 'room');
  applying++;
  try {
    settings.set(sanitizeSettings(clean.game));
    personalStore.set({ ids: clean.plugins.cosmetic });
    uiStore.set({ ids: clean.plugins.ui.slice(0, UI_LIMITS.maxPlugins) });
    if (hasRoom) roomStore.set({ list: clean.plugins.room });
  } finally {
    applying--;
  }
  return clean;
}

/**
 * Wire the settings sync once (main.js calls it at boot). Returns a dispose handle for tests.
 * @param {{ net: any, getAccount?: () => ({ token?: string } | null),
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 *   stores?: { settings?: any, personal?: any, ui?: any, room?: any } }} deps
 *   `getAccount` returns the remembered account (public/js/net.js accountStore); null for a 游客.
 * @returns {{ push: (opts?: { force?: boolean }) => Promise<void>, pull: () => Promise<void>, dispose: () => void }}
 */
export function installSettingsSync({ net, getAccount = () => null, timers = defaultTimers, stores = {} } = {}) {
  const settings = stores.settings || settingsStore;
  const personalStore = stores.personal || personal;
  const uiStore = stores.ui || uiPlugins;
  const roomStore = stores.room || savedRoomPlugins;
  const deps = { settings, personal: personalStore, ui: uiStore, room: roomStore };
  let disposed = false;
  let pushTimer = null;
  let pullTimer = null;
  /** JSON of the last document this session sent. */
  let lastSent = null;
  /** JSON currently in flight (a second edit during it queues another push). */
  let pending = null;

  const signedIn = () => {
    const acct = getAccount();
    return !!(acct && typeof acct.token === 'string' && acct.token);
  };

  const schedulePush = (ms = SETTINGS_PUSH_DEBOUNCE_MS) => {
    if (disposed) return;
    timers.clearTimeout(pushTimer);
    pushTimer = timers.setTimeout(() => { pushTimer = null; void push(); }, ms);
  };
  const schedulePull = (ms = SETTINGS_PULL_DEBOUNCE_MS) => {
    if (disposed) return;
    timers.clearTimeout(pullTimer);
    pullTimer = timers.setTimeout(() => { pullTimer = null; void pull(); }, ms);
  };

  async function push({ force = false } = {}) {
    if (disposed || !signedIn()) return;
    if (net.status !== 'online') { schedulePush(RETRY_MS); return; }
    const doc = buildSettingsDoc(deps);
    if (!doc) return;
    const json = JSON.stringify(doc);
    if (!force && (json === lastSent || json === pending)) return;
    pending = json;
    try {
      await net.request('settings.push', { settings: doc });
      lastSent = json;
    } catch (err) {
      // A lost write is not an error toast: the next edit or welcome tries again.
      console.warn('[settings] push refused', err?.code || err);
      schedulePush(RETRY_MS);
    } finally {
      if (pending === json) pending = null;
    }
  }

  async function pull() {
    if (disposed || !signedIn() || net.status !== 'online') return;
    let reply;
    try {
      reply = await net.request('settings.pull');
    } catch (err) {
      console.warn('[settings] pull refused', err?.code || err);
      schedulePull(RETRY_MS);
      return;
    }
    // A 游客 (or a server without accounts) answers a plain `ok`: nothing to apply, nothing to seed.
    if (!reply || reply.t !== 'settings.sync') return;
    if (reply.settings) {
      // An older document has no `plugins.room`: apply the rest, keep this browser's host choice, and push once so the
      // account gains the field (applyAccountSettings deliberately does not clear it).
      const hadRoom = !!(reply.settings.plugins && typeof reply.settings.plugins === 'object'
        && Object.hasOwn(reply.settings.plugins, 'room'));
      const applied = applyAccountSettings(reply.settings, deps);
      if (applied) lastSent = JSON.stringify(buildSettingsDoc(deps));
      if (applied && !hadRoom) await push({ force: true });
    } else {
      // The account has no document yet: this browser seeds it (the first sign-in on an account).
      await push({ force: true });
    }
  }

  // The stores notify synchronously on every set — including the ones applyAccountSettings makes. `applying` is the
  // guard that keeps an applied account copy from being uploaded straight back.
  const onChange = () => { if (!applying) schedulePush(); };
  const offs = [
    settings.subscribe(onChange),
    personalStore.subscribe(onChange),
    uiStore.subscribe(onChange),
    roomStore.subscribe(onChange),
  ];
  const offWelcome = net.on?.('welcome', () => {
    lastSent = null;
    pending = null;
    schedulePull();
  }) || (() => {});

  return {
    push,
    pull,
    dispose() {
      disposed = true;
      timers.clearTimeout(pushTimer);
      timers.clearTimeout(pullTimer);
      for (const off of offs) off?.();
      offWelcome();
    },
  };
}
