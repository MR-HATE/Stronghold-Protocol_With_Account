// shared/settingsSync.js — the account's settings document (account extension §account).
//
// The document is the one place the account keeps a player's preferences beyond the 干员调配 and the 对局统计:
//
//   { v, game, plugins: { cosmetic: [id…], ui: [id…], room: [{ id, settings? }…] }, lobbyMedia?: { backdrop, music, dim, scene } }
//
//   * `game` is whatever `public/js/ui/gameLogic/settings.js sanitizeSettings` returns — the 设置 dialog's values
//     (volumes, 语音语言, 伤害数字, 画质, 文字大小, 快捷键 …). The server never reads a field: it stores the object as
//     the client wrote it and hands it back, exactly like a stats record. The client owns the schema and its bounds.
//   * `plugins.cosmetic` / `plugins.ui` are the player's own plugin switches: the 外观插件 (`sp.pref.cosmetics`,
//     content.js `personal`) and the 界面插件 (`sp.pref.ui-plugins`, ui/uiPlugins.js) ids.
//   * `plugins.room` is the host's remembered 插件 panel choice: the ids it switched on and the manifest-driven
//     settings it gave them (`{ id, settings }`, the same objects `room.setPlugins` carries). It is a PREFERENCE for
//     the rooms this account hosts, not the room's live set: applying it still goes through the normal
//     `room.setPlugins` check, can be refused, and never changes another player's room. The room's live set / hashes
//     are not part of this document.
//   * `lobbyMedia` is the 大厅背景与音乐 configuration (`sp.pref.lobby.media`, ui/lobbyMedia.js): `{ backdrop, music,
//     dim, scene }`. The actual image/video/music files live in the browser's IndexedDB (`sp-lobby-media`) and are
//     never uploaded.
//   * A ui plugin's own namespaced `sp.plugin.<id>.` values are NOT here: that is the plugin's private storage, not a
//     setting this build defines (docs/PLUGINS.md §14).
//
// The shape is validated in one place (normalizeSettingsDoc) so the client, the protocol validator and the account
// store agree. Unknown top-level fields are dropped: the version gate is what protects a newer client, the same way
// `stats` does. The format version rises when this envelope changes incompatibly.

/** Version of the settings document (`settings.*` frames of the account extension). */
export const SETTINGS_SYNC_VERSION = 1;
/** JSON size a settings document may have. The room-plugin list can carry up to 32 plugins × 32 settings, so this is
 *  larger than the old settings-only guard while still inside the 64 KB frame limit. */
export const SETTINGS_DOC_MAX_BYTES = 56_000;
/** Most ids one of the two plugin switch lists may carry (a browser can hold more ids than installed plugins). */
export const SETTINGS_MAX_PLUGIN_IDS = 64;
/** Most room plugins a remembered host configuration may carry (room.setPlugins itself allows 32). */
export const SETTINGS_MAX_ROOM_PLUGINS = 32;
/** Most manifest settings one room plugin may carry (shared/protocol.js room.setPlugins allows 32). */
export const SETTINGS_MAX_ROOM_SETTINGS = 32;
/** Longest room-setting key / string value (the room.setPlugins validator's bound). */
export const SETTINGS_SETTING_STRING_MAX = 64;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
/** Keys that must never be written from a document into a plain object (prototype pollution). */
const UNSAFE_KEY = Object.freeze(new Set(['__proto__', 'prototype', 'constructor']));

/** @param {unknown} id */
export const isSettingsPluginId = (id) => typeof id === 'string' && PLUGIN_ID_RE.test(id);

/**
 * A plugin-id list as stored: valid ids only, de-duplicated, sorted (the stores keep sorted ids too). null when the
 * value is not a list or carries more than SETTINGS_MAX_PLUGIN_IDS entries.
 * @param {unknown} raw
 * @returns {string[] | null}
 */
function pluginIdList(raw) {
  if (!Array.isArray(raw) || raw.length > SETTINGS_MAX_PLUGIN_IDS) return null;
  const out = [];
  for (const id of raw) {
    if (!isSettingsPluginId(id)) return null;
    if (!out.includes(id)) out.push(id);
  }
  return out.sort();
}

/** Whether one manifest setting value is the scalar `room.setPlugins` accepts. */
const isSettingScalar = (v) => typeof v === 'boolean'
  || (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && v.length <= SETTINGS_SETTING_STRING_MAX && !v.includes('\u0000'));

/**
 * The host's remembered 插件 panel choice: `[{ id, settings? }]` with valid plugin ids, scalar settings and bounded
 * counts. null when the value is not that shape. Ids are de-duplicated (the last entry wins) and sorted.
 * @param {unknown} raw
 * @returns {{ id: string, settings?: Record<string, boolean|number|string> }[] | null}
 */
export function sanitizeRoomPlugins(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > SETTINGS_MAX_ROOM_PLUGINS) return null;
  const byId = new Map();
  for (const p of raw) {
    if (!isObj(p) || !isSettingsPluginId(p.id)) return null;
    if (p.settings !== undefined && !isObj(p.settings)) return null;
    const settings = p.settings || {};
    const keys = Object.keys(settings);
    if (keys.length > SETTINGS_MAX_ROOM_SETTINGS) return null;
    const clean = {};
    for (const k of keys) {
      if (typeof k !== 'string' || k.length === 0 || k.length > SETTINGS_SETTING_STRING_MAX) return null;
      if (UNSAFE_KEY.has(k)) return null;
      if (!isSettingScalar(settings[k])) return null;
      clean[k] = settings[k];
    }
    byId.set(p.id, keys.length ? { id: p.id, settings: clean } : { id: p.id });
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Known lobby scene ids (`public/js/ui/hubScene.js`). */
export const LOBBY_SCENE_IDS = Object.freeze(['official', 'night', 'frost', 'ember', 'calm']);

/**
 * Sanitise the 大厅背景与音乐 configuration (`sp.pref.lobby.media`, ui/lobbyMedia.js), or null when `raw` is present
 * and not an object.
 * @param {unknown} raw
 * @returns {{ backdrop: boolean, music: boolean, dim: number, scene: string } | undefined | null}
 */
export function sanitizeLobbyMedia(raw) {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) return null;
  const dim = Number(raw.dim);
  return {
    backdrop: raw.backdrop === true,
    music: raw.music === true,
    dim: Number.isFinite(dim) ? Math.min(0.8, Math.max(0, Math.round(dim * 1000) / 1000)) : 0.35,
    scene: typeof raw.scene === 'string' && LOBBY_SCENE_IDS.includes(raw.scene) ? raw.scene : 'official',
  };
}

/**
 * Validate and normalise a settings document, or null when it is not this build's shape. The `game` object is carried
 * verbatim (its fields are the client's schema); the plugin id lists, the remembered room-plugin configuration and the
 * optional `lobbyMedia` preferences are checked and normalised.
 * @param {any} raw
 * @returns {{ v: number, game: Record<string, any>, plugins: { cosmetic: string[], ui: string[], room: { id: string, settings?: Record<string, boolean|number|string> }[] }, lobbyMedia?: { backdrop: boolean, music: boolean, dim: number, scene: string } } | null}
 */
export function normalizeSettingsDoc(raw) {
  if (!isObj(raw) || raw.v !== SETTINGS_SYNC_VERSION) return null;
  if (!isObj(raw.game)) return null;
  if (!isObj(raw.plugins)) return null;
  const cosmetic = raw.plugins.cosmetic === undefined ? [] : pluginIdList(raw.plugins.cosmetic);
  const ui = raw.plugins.ui === undefined ? [] : pluginIdList(raw.plugins.ui);
  const room = sanitizeRoomPlugins(raw.plugins.room);
  const lobbyMedia = sanitizeLobbyMedia(raw.lobbyMedia);
  if (!cosmetic || !ui || !room || lobbyMedia === null) return null;
  const doc = {
    v: SETTINGS_SYNC_VERSION,
    game: raw.game,
    plugins: { cosmetic, ui, room },
    ...(lobbyMedia !== undefined ? { lobbyMedia } : {}),
  };
  // A UTF-8 string is never shorter than its UTF-16 code-unit length, so this bounds the wire payload roughly; the
  // server checks the exact UTF-8 bytes (server/accounts.js saveSettings). A client document is far below this.
  try {
    if (JSON.stringify(doc).length > SETTINGS_DOC_MAX_BYTES) return null;
  } catch {
    return null;
  }
  return doc;
}

/**
 * Whether `raw` is a settings document this build accepts (the protocol validator's predicate).
 * @param {any} raw
 * @returns {boolean}
 */
export function isSettingsDoc(raw) {
  return normalizeSettingsDoc(raw) != null;
}
