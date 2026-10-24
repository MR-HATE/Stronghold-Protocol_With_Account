// server/accounts.js — the optional account store (DESIGN extension §account), now backed by SQLite.
//
// Optional and self-contained: the server runs without it (tests and a bare `node server/index.js` do), and the
// only things that need it are the lobby's auth handlers and accountHello.
//
// Storage lives in `accounts.db` under the account data dir (`ACCOUNTS_DIR`): one row per account, one row per
// 干员调配 item, one row per 对局统计 record and one document per synced preference kind (`settings`).
//
// An account has TWO names (shared/account.js):
//   * `user_key` — the ACCOUNT ID, the stable login credential. It never changes. A new account gets a generated
//     `sp-…` id; an account migrated from the old JSON store keeps its lowercased username as its id, so existing
//     players sign in with the name they already know.
//   * `name` — the USERNAME, the in-game name. It may be changed at any time, is not unique and is never a
//     credential (register / login / rename in this file). It is stored with the player's spelling, not lowercased.
// An entry that lacks a field this build does not know is carried through in `extra_json`, so a newer build's
// account data is never destroyed by an older one.
//
// A JSON store written by an older build (`accounts.json` in the same directory) is imported once, in a single
// transaction, when the database does not exist yet (or exists without accounts). The file is then renamed to
// `accounts.json.imported` and kept — never deleted. A corrupt JSON file is an error that disables the account
// store and is reported at boot; it is never silently replaced by an empty store.
//
// - Password: Node's `scrypt` (built-in, no extra dep) with a per-user random salt. `hash_scheme` records the cost
//   parameters so a future build can upgrade them without invalidating old accounts.
// - "account token": a 32-byte random hex string returned on register / login; the client stores it like the
//   reconnect token (localStorage, public/js/net.js accountStore) and passes it on every `hello`. It binds the
//   干员调配 — and the SEAT (a room / a running match) — to a human identity across tabs, devices and server
//   restarts, unlike the ephemeral session `playerId`, which is thrown away when the process restarts. ONE bearer
//   per account: `login` hands back the token the account already has, because the lobby resolves the token to the
//   account and then to the seat that account holds, so signing in on a second device must land on that same seat
//   (a rotated token would leave the first device holding it with a dead one — extension §account,
//   docs/design/network.md). It is a password-equivalent secret, valid until the entry is deleted; there is no
//   revocation and no device list (NOT a full auth system, below).
// - The loadout is stored verbatim in the shapes `room.loadout` expects (entries / ops), with no semantic
//   validation here: the lobby re-validates against the live game data, so a stale entry is dropped on the next
//   sync — exactly the way an unauthenticated loadout is.
// - `stats` is the 对局统计 mirror: the same envelope the browser keeps locally, UNIONED with what the account
//   already holds on every push and bounded to a byte budget (server/stats.js), so two devices pushing in any order
//   never lose each other's matches. `statsClearedAt` is the stamp of the last 清空统计数据: a client that still has
//   records older than it drops them instead of uploading them back (the clear sticks across devices).
// - `settings` is the synced 设置 + personal-plugin switches document (shared/settingsSync.js): the client owns its
//   schema, the server stores it whole and assigns the write stamp. Last writer wins; the login reply / pull hands
//   the account's copy back.
// - Concurrency: single-process Node; every mutation is one SQLite transaction (WAL), so a crash can roll back the
//   last write but never corrupt the store. The database is the only source of truth — no in-memory copy to go
//   stale when another connection (a test, a tool) writes.
//
// NOT a full auth system: no email, no password reset, no rate limiting beyond the per-IP socket limit already in
// net.js, and no access control (anyone with the address may play without an account). Good enough for a friend
// group playing a fan remake — not production internet scale.

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { STATS_VERSION } from '../shared/constants.js';
import { ACCOUNT_NAME_MAX, sanitizeAccountName, normalizeAccountId } from '../shared/account.js';
import { normalizeSettingsDoc, SETTINGS_DOC_MAX_BYTES } from '../shared/settingsSync.js';
import { isSkinSelection } from '../shared/protocol.js';
import { mergeStatsPayload, normalizeStatsPayload } from './stats.js';

const scryptAsync = promisify(crypto.scrypt);
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 }; // interactive login cost; ~10 ms per verify
const SCRYPT_SCHEME = 'scrypt-16384-8-1';
const TOKEN_BYTES = 32;
const DB_VERSION = 2;
const SETTINGS_KIND = 'settings';
const POTENTIAL_DEFAULT = 6;
const CULTIVATE_DEFAULT = 3;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const stampOf = (r) => (Number.isFinite(r?.t) ? r.t : 0);
const recordId = (r) => (isObj(r) && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64 ? r.id : null);

/**
 * @typedef {{ name: string, salt: string, hash: string, hashScheme?: string, token?: string|null,
 *             loadout: Record<string, any> | null, ops: Record<string, any> | null,
 *             skins: Record<string, string> | null,
 *             stats: { v: number, records: any[] } | null, statsClearedAt: number | null,
 *             settings?: Record<string, any> | null, settingsUpdatedAt?: number | null,
 *             createdAt: number, lastLoginAt: number, [extra: string]: any }} AccountRecord
 *   `loadout` / `ops` mirror `room.loadout`'s two maps (DESIGN §16 / the 0.2.2 潜能·练度 addition); both are
 *   null until the player has sent one. `stats` is the 对局统计 mirror (server/stats.js) and `statsClearedAt` the
 *   stamp of its last 清空. `settings` is the synced settings document (shared/settingsSync.js). Unknown fields of
 *   an existing entry are preserved as-is.
 */

export class AccountStore {
  /**
   * @param {{ dir: string, log?: object }} opts `dir` holds `accounts.db` (and, once, a legacy `accounts.json`);
   *   it is created on the first write
   */
  constructor({ dir, log }) {
    this.dir = path.resolve(dir);
    this.file = path.join(this.dir, 'accounts.db');
    this.legacyFile = path.join(this.dir, 'accounts.json');
    /** @type {DatabaseSync | null} */
    this.db = null;
    this.log = log || { info() {}, warn() {}, error() {} };
    this._loadPromise = null;
    this._openPromise = null;
  }

  /**
   * Open the database (idempotent; no file is created until the first account / write, so a read-only or unused
   * server does not leave an empty database behind). Imports a legacy `accounts.json` when there is one.
   */
  async load() {
    if (this._loadPromise) return this._loadPromise;
    this._loadPromise = (async () => {
      const dbThere = await fileExists(this.file);
      const jsonThere = await fileExists(this.legacyFile);
      if (!dbThere && !jsonThere) return; // nothing to read, nothing to migrate
      if (!dbThere) {
        await fsp.mkdir(this.dir, { recursive: true });
        this._open();
        this._migrate();
        await this._importLegacy({ emptyOnly: false });
        return;
      }
      this._open();
      this._migrate();
      if (jsonThere && this._accountCount() === 0) await this._importLegacy({ emptyOnly: true });
      this.log.info(`[accounts] opened ${this.file} (${this._accountCount()} account(s))`);
    })().catch((e) => {
      this._loadPromise = null;
      this.close();
      throw e;
    });
    return this._loadPromise;
  }

  /** Create the database on the first write (the read paths stay file-free). Concurrent first writes share one open. */
  _ensureDb() {
    if (this.db) return Promise.resolve();
    if (this._openPromise) return this._openPromise;
    this._openPromise = (async () => {
      await this.load();
      if (this.db) return;
      await fsp.mkdir(this.dir, { recursive: true });
      this._open();
      this._migrate();
      this.log.info(`[accounts] created ${this.file}`);
    })().finally(() => { this._openPromise = null; });
    return this._openPromise;
  }

  /** @param {string} file @param {string} text */
  _open() {
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA foreign_keys = ON');
  }

  /** @param {string} file */
  _migrate() {
    const row = this.db.prepare('PRAGMA user_version').get();
    const version = Number(row?.user_version ?? 0);
    if (version > DB_VERSION) throw new Error(`accounts.db schema ${version} is newer than this build (${DB_VERSION})`);
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
          user_key         TEXT PRIMARY KEY,
          name             TEXT NOT NULL,
          salt             TEXT NOT NULL,
          hash             TEXT NOT NULL,
          hash_scheme      TEXT NOT NULL DEFAULT '${SCRYPT_SCHEME}',
          token            TEXT UNIQUE,
          loadout_saved    INTEGER NOT NULL DEFAULT 0,
          ops_saved        INTEGER NOT NULL DEFAULT 0,
          skins_json       TEXT,
          stats_v          INTEGER,
          stats_cleared_at INTEGER,
          created_at       INTEGER NOT NULL,
          last_login_at    INTEGER NOT NULL,
          extra_json       TEXT
        );
        CREATE TABLE IF NOT EXISTS loadout_entries (
          user_key  TEXT NOT NULL REFERENCES accounts(user_key) ON DELETE CASCADE ON UPDATE CASCADE,
          chess_id  TEXT NOT NULL,
          skill     INTEGER NOT NULL CHECK (skill >= 0),
          module    TEXT,
          PRIMARY KEY (user_key, chess_id)
        );
        CREATE TABLE IF NOT EXISTS loadout_ops (
          user_key   TEXT NOT NULL REFERENCES accounts(user_key) ON DELETE CASCADE ON UPDATE CASCADE,
          char_id    TEXT NOT NULL,
          potential  INTEGER NOT NULL CHECK (potential BETWEEN 1 AND 6),
          cultivate  INTEGER NOT NULL CHECK (cultivate BETWEEN 0 AND 3),
          PRIMARY KEY (user_key, char_id)
        );
        CREATE TABLE IF NOT EXISTS stats_records (
          user_key   TEXT NOT NULL REFERENCES accounts(user_key) ON DELETE CASCADE ON UPDATE CASCADE,
          record_id  TEXT NOT NULL,
          t          INTEGER NOT NULL,
          seq        INTEGER NOT NULL,
          json       TEXT NOT NULL,
          PRIMARY KEY (user_key, record_id)
        );
        CREATE TABLE IF NOT EXISTS account_docs (
          user_key   TEXT NOT NULL REFERENCES accounts(user_key) ON DELETE CASCADE ON UPDATE CASCADE,
          kind       TEXT NOT NULL,
          json       TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (user_key, kind)
        );
        CREATE INDEX IF NOT EXISTS stats_by_time ON stats_records (user_key, t DESC, seq);
      `);
    }
    // v2: the account's 干员皮肤 choices (`{ [charId]: skinId }`, docs/SKINS.md). A v1 database opened by this build
    // gets the column in place; a fresh v1 CREATE above already includes it.
    const columns = this.db.prepare('PRAGMA table_info(accounts)').all();
    if (!columns.some((c) => c.name === 'skins_json')) this.db.exec('ALTER TABLE accounts ADD COLUMN skins_json TEXT');
    this.db.exec(`PRAGMA user_version = ${DB_VERSION}`);
  }

  /** @param {() => any} fn @returns {any} */
  _tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  _accountCount() {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get();
    return Number(row?.n ?? 0);
  }

  /**
   * One account as the public API has always returned it (plus the internal `token` / `loadoutSaved` fields the
   * login path needs).
   * @param {string} key
   * @returns {AccountRecord | null}
   */
  _readAccount(key) {
    const row = this.db.prepare('SELECT * FROM accounts WHERE user_key = ?').get(key);
    if (!row) return null;
    const extra = parseJsonObject(row.extra_json, this.log, `extra_json of ${key}`);
    const rec = {
      ...(extra || {}),
      key: row.user_key,
      name: row.name,
      salt: row.salt,
      hash: row.hash,
      hashScheme: row.hash_scheme,
      token: typeof row.token === 'string' ? row.token : null,
      loadout: row.loadout_saved ? this._readLoadout(key) : null,
      ops: row.ops_saved ? this._readOps(key) : null,
      skins: parseSkinsJson(row.skins_json, this.log, key),
      stats: row.stats_v == null ? null : { v: Number(row.stats_v), records: this._readStatsRecords(key) },
      statsClearedAt: row.stats_cleared_at == null ? null : Number(row.stats_cleared_at),
      createdAt: Number(row.created_at),
      lastLoginAt: Number(row.last_login_at),
      ...this._readSettingsDoc(key),
    };
    return rec;
  }

  /** @param {string} key */
  _readLoadout(key) {
    const rows = this.db.prepare('SELECT chess_id, skill, module FROM loadout_entries WHERE user_key = ?').all(key);
    const out = {};
    for (const r of rows) out[r.chess_id] = { skill: Number(r.skill), module: typeof r.module === 'string' ? r.module : null };
    return out;
  }

  /** @param {string} key */
  _readOps(key) {
    const rows = this.db.prepare('SELECT char_id, potential, cultivate FROM loadout_ops WHERE user_key = ?').all(key);
    const out = {};
    for (const r of rows) out[r.char_id] = { potential: Number(r.potential), cultivate: Number(r.cultivate) };
    return out;
  }

  /** @param {string} key */
  _readStatsRecords(key) {
    const rows = this.db.prepare('SELECT json FROM stats_records WHERE user_key = ? ORDER BY t DESC, seq').all(key);
    const out = [];
    for (const r of rows) {
      try { out.push(JSON.parse(r.json)); } catch (e) { this.log.warn(`[accounts] unreadable stats record for ${key}`, e.message); }
    }
    return out;
  }

  /**
   * @param {string} key
   * @returns {{ settings: Record<string, any> | null, settingsUpdatedAt: number | null }}
   */
  _readSettingsDoc(key) {
    const row = this.db.prepare('SELECT json, updated_at FROM account_docs WHERE user_key = ? AND kind = ?').get(key, SETTINGS_KIND);
    if (!row) return { settings: null, settingsUpdatedAt: null };
    let parsed;
    try { parsed = JSON.parse(row.json); } catch (e) {
      this.log.warn(`[accounts] unreadable settings document for ${key}`, e.message);
      return { settings: null, settingsUpdatedAt: null };
    }
    const doc = normalizeSettingsDoc(parsed);
    if (!doc) return { settings: null, settingsUpdatedAt: null };
    // An account document written before `plugins.room` existed must not be handed back as "the host has no
    // remembered choice": leave the field out, so the client keeps its local choice and upgrades the account on its
    // next push. New documents always carry the field.
    if (isObj(parsed.plugins) && !Object.hasOwn(parsed.plugins, 'room')) {
      const plugins = { ...doc.plugins };
      delete plugins.room;
      return { settings: { ...doc, plugins }, settingsUpdatedAt: Number(row.updated_at) };
    }
    return { settings: doc, settingsUpdatedAt: Number(row.updated_at) };
  }

  /**
   * Register a new account: `username` is the display name, the account ID is generated (or, for a browser recovering
   * the store it just lost, the id it still remembers). The username need not be unique.
   * @param {string} username display name / in-game name
   * @param {string} password
   * @param {{ accountId?: string | null }} [opts] `accountId`: recovery of a lost local account, never trusted as a
   *   credential — the account is new and the caller already proved nothing (registration itself is open)
   * @returns {Promise<{ ok: true, key: string, accountId: string, username: string, token: string, loadout: Record<string,any>|null, ops: Record<string,any>|null, stats: { v: number, records: any[] }|null, statsClearedAt: number|null, settings: Record<string,any>|null, settingsUpdatedAt: number|null }
   *                   | { error: 'BAD_MSG'|'TAKEN'|'WEAK'|'INTERNAL', detail: string }>}
   */
  async register(username, password, { accountId = null } = {}) {
    await this._ensureDb();
    const name = sanitizeAccountName(username);
    if (!name) return { error: 'BAD_MSG', detail: `username must be 1-${ACCOUNT_NAME_MAX} printable characters` };
    if (typeof password !== 'string' || password.length < 4 || password.length > 128) return { error: 'WEAK', detail: 'password must be 4-128 chars' };
    const requested = accountId == null ? null : normalizeAccountId(accountId);
    if (accountId != null && !requested) return { error: 'BAD_MSG', detail: 'bad account id' };
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = (await scryptAsync(password, salt, 64, SCRYPT_OPTS)).toString('hex');
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const now = Date.now();
    for (let attempt = 0; attempt < 8; attempt++) {
      const key = requested || newAccountId();
      const inserted = this._tx(() => this.db.prepare(`
        INSERT INTO accounts (user_key, name, salt, hash, hash_scheme, token, loadout_saved, ops_saved, stats_v,
          stats_cleared_at, created_at, last_login_at, extra_json)
        VALUES (?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, ?, ?, NULL)
        ON CONFLICT(user_key) DO NOTHING
      `).run(key, name, salt, hash, SCRYPT_SCHEME, token, now, now).changes > 0);
      if (inserted) return { ok: true, key, accountId: key, username: name, token, loadout: null, ops: null, skins: null, stats: null, statsClearedAt: null, settings: null, settingsUpdatedAt: null };
      // A requested id that exists is a real conflict (the caller should sign in); a generated one only collided.
      if (requested) return { error: 'TAKEN', detail: 'account id already registered' };
    }
    return { error: 'INTERNAL', detail: 'could not allocate an account id' };
  }

  /**
   * Log in with the stable ACCOUNT ID and the password. The username is not accepted here: it is only a display
   * name and may be changed or shared by two accounts.
   * @param {string} accountId
   * @param {string} password
   * @returns {Promise<{ ok: true, key: string, accountId: string, username: string, token: string, loadout: Record<string,any>|null, ops: Record<string,any>|null, stats: { v: number, records: any[] }|null, statsClearedAt: number|null, settings: Record<string,any>|null, settingsUpdatedAt: number|null }
   *                   | { error: 'BAD_MSG'|'NOT_FOUND'|'BAD_PASSWORD', detail: string }>}
   */
  async login(accountId, password) {
    await this.load();
    if (!this.db) return { error: 'NOT_FOUND', detail: 'no such account' };
    const key = normalizeAccountId(accountId);
    if (!key) return { error: 'NOT_FOUND', detail: 'no such account' };
    const row = this.db.prepare('SELECT * FROM accounts WHERE user_key = ?').get(key);
    if (!row) return { error: 'NOT_FOUND', detail: 'no such account' };
    const hash = await scryptAsync(String(password || ''), row.salt, 64, SCRYPT_OPTS);
    const expected = Buffer.from(row.hash, 'hex');
    if (hash.length !== expected.length || !(crypto.timingSafeEqual(hash, expected))) {
      return { error: 'BAD_PASSWORD', detail: 'wrong password' };
    }
    // The account keeps its one bearer (see the header): a login from a second device must be able to reach the
    // seat the first device holds, which needs the same token — the lobby resolves it to the account and then to
    // that account's session (lobby.js sessionForAccount). A legacy entry without a token gets one now.
    const rec = this._tx(() => {
      let token = typeof row.token === 'string' && row.token ? row.token : null;
      if (!token) {
        token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
        this.db.prepare('UPDATE accounts SET token = ? WHERE user_key = ?').run(token, key);
      }
      this.db.prepare('UPDATE accounts SET last_login_at = ? WHERE user_key = ?').run(Date.now(), key);
      return this._readAccount(key);
    });
    if (!rec) return { error: 'NOT_FOUND', detail: 'no such account' };
    // the registered spelling, not what was typed (the account id is case-insensitive)
    return { ok: true, key, accountId: key, username: rec.name, token: rec.token, loadout: rec.loadout || null, ops: rec.ops || null,
      skins: rec.skins ?? null,
      stats: rec.stats || null, statsClearedAt: rec.statsClearedAt ?? null,
      settings: rec.settings || null, settingsUpdatedAt: rec.settingsUpdatedAt ?? null };
  }

  /**
   * Change the display username of the account behind a bearer token. The account ID does not change, and the name
   * does not have to be unique. An unknown token / empty name changes nothing.
   * @param {string} token
   * @param {string} username
   * @returns {Promise<{ ok: true, accountId: string, username: string } | { error: 'BAD_MSG'|'NOT_FOUND', detail: string }>}
   */
  async rename(token, username) {
    await this.load();
    if (!this.db || typeof token !== 'string') return { error: 'NOT_FOUND', detail: 'no such account' };
    const name = sanitizeAccountName(username);
    if (!name) return { error: 'BAD_MSG', detail: `username must be 1-${ACCOUNT_NAME_MAX} printable characters` };
    const key = this._keyForToken(token);
    if (!key) return { error: 'NOT_FOUND', detail: 'no such account' };
    this.db.prepare('UPDATE accounts SET name = ? WHERE user_key = ?').run(name, key);
    return { ok: true, accountId: key, username: name };
  }

  /**
   * Synchronous token → account lookup, for the one path that cannot await: a `hello` frame resolving to the
   * seat its account holds (server/lobby.js sessionForAccount). The database is opened once at boot —
   * server/http/websocket.js awaits `load()` before the server accepts connections — and a query is a single
   * indexed read. An unloaded store (a unit test that never called `load`) or an unknown token simply answers null.
   * @param {unknown} token
   * @returns {{ key: string, accountId: string, username: string, loadout: Record<string,any>|null, ops: Record<string,any>|null,
   *             skins: Record<string,string>|null,
   *             stats: { v: number, records: any[] }|null, statsClearedAt: number|null,
   *             settings: Record<string,any>|null, settingsUpdatedAt: number|null } | null}
   */
  lookupToken(token) {
    if (!this.db || typeof token !== 'string') return null;
    const key = this._keyForToken(token);
    if (!key) return null;
    const rec = this._readAccount(key);
    if (!rec) return null;
    return { key, accountId: key, username: rec.name || key, loadout: rec.loadout || null, ops: rec.ops || null,
      skins: rec.skins ?? null,
      stats: rec.stats || null, statsClearedAt: rec.statsClearedAt ?? null,
      settings: rec.settings || null, settingsUpdatedAt: rec.settingsUpdatedAt ?? null };
  }

  /**
   * Resolve a previously issued account token.
   * @param {string} token
   * @returns {Promise<{ key: string, accountId: string, username: string, loadout: Record<string,any>|null, ops: Record<string,any>|null,
   *                     stats: { v: number, records: any[] }|null, statsClearedAt: number|null,
   *                     settings: Record<string,any>|null, settingsUpdatedAt: number|null } | null>}
   */
  async resolveToken(token) {
    await this.load();
    return this.lookupToken(token);
  }

  /** @param {string} token @returns {string | null} */
  _keyForToken(token) {
    const row = this.db.prepare('SELECT user_key FROM accounts WHERE token = ?').get(token.toLowerCase());
    return row ? row.user_key : null;
  }

  /**
   * Persist the current 干员调配 for an account token (no-op when the token is unknown). Both maps are stored
   * as sent (`null` clears one); the lobby has already checked them against the game data.
   * @param {string} token
   * @param {Record<string, any>} loadout `room.loadout.entries`
   * @param {Record<string, any>|null} [ops] `room.loadout.ops`
   */
  async saveLoadout(token, loadout, ops = null) {
    await this.load();
    if (!this.db || typeof token !== 'string') return;
    const key = this._keyForToken(token);
    if (!key) return;
    const rec = this._readAccount(key);
    if (!rec) return;
    const nextLoadout = isObj(loadout) ? loadout : null;
    const nextOps = isObj(ops) ? ops : null;
    // Never create an account's copy as empty: an account with nothing saved and a session that sends nothing is a
    // client that has not received the account's copy yet (or a stray reset), not a deliberate blank 干员调配.
    // Clearing a copy that DOES exist stays possible — that is the deliberate reset, and it goes through a session
    // the account was already written on (see enterAsGuest / auth.logout in DESIGN §account).
    if (rec.loadout == null && rec.ops == null && !hasEntries(nextLoadout) && !hasEntries(nextOps)) return;
    try {
      this._tx(() => {
        this.db.prepare('DELETE FROM loadout_entries WHERE user_key = ?').run(key);
        this.db.prepare('DELETE FROM loadout_ops WHERE user_key = ?').run(key);
        const insEntry = this.db.prepare('INSERT INTO loadout_entries (user_key, chess_id, skill, module) VALUES (?, ?, ?, ?)');
        for (const [chessId, e] of Object.entries(nextLoadout || {})) {
          if (!isObj(e)) continue;
          const skill = Number.isFinite(e.skill) && e.skill >= 0 ? Math.trunc(e.skill) : 0;
          const module = typeof e.module === 'string' ? e.module : null;
          insEntry.run(key, chessId, skill, module);
        }
        const insOp = this.db.prepare('INSERT INTO loadout_ops (user_key, char_id, potential, cultivate) VALUES (?, ?, ?, ?)');
        for (const [charId, e] of Object.entries(nextOps || {})) {
          if (!isObj(e)) continue;
          const potential = Number.isFinite(e.potential) ? Math.min(6, Math.max(1, Math.trunc(e.potential))) : POTENTIAL_DEFAULT;
          const cultivate = Number.isFinite(e.cultivate) ? Math.min(3, Math.max(0, Math.trunc(e.cultivate))) : CULTIVATE_DEFAULT;
          insOp.run(key, charId, potential, cultivate);
        }
        this.db.prepare('UPDATE accounts SET loadout_saved = ?, ops_saved = ? WHERE user_key = ?')
          .run(nextLoadout ? 1 : 0, nextOps ? 1 : 0, key);
      });
    } catch (e) {
      this.log.error('[accounts] saveLoadout failed', e);
    }
  }

  /**
   * Persist the 干员皮肤 selection (`{ [charId]: skinId }`, docs/SKINS.md) for an account token. An empty object is a
   * real value (the player cleared every skin) and is stored as `{}`; it is not the same as "no copy" (`null`).
   * The shape is checked structurally here; whether an operator exists in a room's content is checked by room.skins.
   * @param {string} token
   * @param {Record<string, string>} skins
   * @returns {Promise<Record<string, string> | null>} the stored selection, or null when refused
   */
  async saveSkins(token, skins) {
    await this.load();
    if (!this.db || typeof token !== 'string' || !isSkinSelection(skins)) return null;
    const key = this._keyForToken(token);
    if (!key) return null;
    try {
      this._tx(() => this.db.prepare('UPDATE accounts SET skins_json = ? WHERE user_key = ?').run(JSON.stringify(skins), key));
    } catch (e) {
      this.log.error('[accounts] saveSkins failed', e);
      return null;
    }
    return skins;
  }

  /**
   * The account's 干员皮肤 selection, or null (no token / never saved). `{}` is a saved empty selection.
   * @param {string} token
   * @returns {Promise<Record<string, string> | null>}
   */
  async readSkins(token) {
    await this.load();
    if (!this.db || typeof token !== 'string') return null;
    const key = this._keyForToken(token);
    if (!key) return null;
    const row = this.db.prepare('SELECT skins_json FROM accounts WHERE user_key = ?').get(key);
    return row ? parseSkinsJson(row.skins_json, this.log, key) : null;
  }

  /**
   * Merge a 对局统计 envelope into the account's mirror (no-op when the token is unknown or the payload is not one).
   * The union is what makes the mirror safe to push from any device in any order (server/stats.js
   * mergeStatsPayload); records the account already has, or that a 清空 stamped as gone, are dropped.
   * @param {string} token
   * @param {any} payload `{ v, records }` from `stats.push`
   * @returns {Promise<{ v: number, records: any[] } | null>} the mirror after the merge
   */
  async saveStats(token, payload) {
    await this.load();
    if (!this.db || typeof token !== 'string') return null;
    const key = this._keyForToken(token);
    if (!key) return null;
    const rec = this._readAccount(key);
    if (!rec) return null;
    const incoming = normalizeStatsPayload(payload);
    if (!incoming) return null;
    // a 清空 is a lower bound on the mirror's timeline: a device that still holds the records it cleared must not
    // push them back (the clear has to stick across devices, see statsClearedAt)
    const clearedAt = Number.isFinite(rec.statsClearedAt) ? rec.statsClearedAt : null;
    const kept = clearedAt == null ? incoming.records : incoming.records.filter((r) => !(Number.isFinite(r?.t) && r.t <= clearedAt));
    const next = mergeStatsPayload(rec.stats, { v: incoming.v, records: kept });
    try {
      this._tx(() => this._writeStats(key, next));
    } catch (e) {
      this.log.error('[accounts] saveStats failed', e);
    }
    return next;
  }

  /**
   * Replace an account's stats rows with the merged envelope (see saveStats). Only changed rows are written; the
   * `seq` column keeps the stored-first tie order of `mergeStatsPayload` when two records have the same `t`.
   * @param {string} key @param {{ v: number, records: any[] }} next
   */
  _writeStats(key, next) {
    const existing = new Map();
    let maxSeq = 0;
    for (const r of this.db.prepare('SELECT record_id, t, seq, json FROM stats_records WHERE user_key = ?').all(key)) {
      existing.set(r.record_id, r);
      if (Number(r.seq) > maxSeq) maxSeq = Number(r.seq);
    }
    const nextIds = new Set();
    const ins = this.db.prepare('INSERT INTO stats_records (user_key, record_id, t, seq, json) VALUES (?, ?, ?, ?, ?)');
    const upd = this.db.prepare('UPDATE stats_records SET t = ?, json = ? WHERE user_key = ? AND record_id = ?');
    const del = this.db.prepare('DELETE FROM stats_records WHERE user_key = ? AND record_id = ?');
    for (const r of next.records) {
      const id = recordId(r);
      if (!id) continue;
      nextIds.add(id);
      const json = JSON.stringify(r);
      const t = stampOf(r);
      const prev = existing.get(id);
      if (!prev) ins.run(key, id, t, ++maxSeq, json);
      else if (String(prev.json) !== json || Number(prev.t) !== t) upd.run(t, json, key, id);
    }
    for (const id of existing.keys()) if (!nextIds.has(id)) del.run(key, id);
    this.db.prepare('UPDATE accounts SET stats_v = ? WHERE user_key = ?').run(next.v, key);
  }

  /**
   * Drop the account's 对局统计 mirror and stamp the moment (清空统计数据): every client drops the records it holds
   * that are older than the stamp on its next pull, so the clear survives a device that had not synced yet.
   * @param {string} token
   * @returns {Promise<number | null>} the stamp, or null when the token is unknown
   */
  async clearStats(token) {
    await this.load();
    if (!this.db || typeof token !== 'string') return null;
    const key = this._keyForToken(token);
    if (!key) return null;
    const rec = this._readAccount(key);
    if (!rec) return null;
    const now = Date.now();
    try {
      this._tx(() => {
        this.db.prepare('DELETE FROM stats_records WHERE user_key = ?').run(key);
        this.db.prepare('UPDATE accounts SET stats_v = NULL, stats_cleared_at = ? WHERE user_key = ?').run(now, key);
      });
    } catch (e) {
      this.log.error('[accounts] clearStats failed', e);
    }
    return now;
  }

  /**
   * The account's 对局统计 mirror, or null (no token / nothing stored).
   * @param {string} token
   * @returns {Promise<{ stats: { v: number, records: any[] } | null, clearedAt: number | null } | null>}
   */
  async readStats(token) {
    await this.load();
    if (!this.db || typeof token !== 'string') return null;
    const key = this._keyForToken(token);
    if (!key) return null;
    const rec = this._readAccount(key);
    if (!rec) return null;
    return { stats: rec.stats || null, clearedAt: rec.statsClearedAt ?? null };
  }

  /**
   * Store the synced settings document (shared/settingsSync.js). The store never reads its fields: the client owns
   * the schema, exactly as with a stats record. A payload that is not this build's shape is refused.
   * @param {string} token
   * @param {any} payload `{ v, game, plugins }` from `settings.push`
   * @returns {Promise<{ v: number, game: Record<string, any>, plugins: { cosmetic: string[], ui: string[] } } | null>}
   *   the stored document, or null when the token / payload is not usable
   */
  async saveSettings(token, payload) {
    await this.load();
    if (!this.db || typeof token !== 'string') return null;
    const key = this._keyForToken(token);
    if (!key) return null;
    const doc = normalizeSettingsDoc(payload);
    if (!doc) return null;
    const json = JSON.stringify(doc);
    if (Buffer.byteLength(json, 'utf8') > SETTINGS_DOC_MAX_BYTES) return null;
    try {
      this._tx(() => this.db.prepare(`
        INSERT INTO account_docs (user_key, kind, json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_key, kind) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
      `).run(key, SETTINGS_KIND, json, Date.now()));
    } catch (e) {
      this.log.error('[accounts] saveSettings failed', e);
      return null;
    }
    return doc;
  }

  /**
   * The account's settings document and its write stamp, or null (no token / unknown account).
   * @param {string} token
   * @returns {Promise<{ settings: Record<string, any> | null, updatedAt: number | null } | null>}
   */
  async readSettings(token) {
    await this.load();
    if (!this.db || typeof token !== 'string') return null;
    const key = this._keyForToken(token);
    if (!key) return null;
    const doc = this._readSettingsDoc(key);
    return { settings: doc.settings, updatedAt: doc.settingsUpdatedAt };
  }

  /**
   * Import a legacy `accounts.json` (the old layout) in one transaction, then keep it as `accounts.json.imported`.
   * @param {{ emptyOnly: boolean }} opts
   */
  async _importLegacy({ emptyOnly }) {
    let raw;
    try { raw = await fsp.readFile(this.legacyFile, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) { throw new Error(`accounts.json is not valid JSON: ${e.message}`, { cause: e }); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('accounts.json is not an object');
    // Two keys differing only by case are one account (the old in-memory Map had already collapsed them): keep the
    // last, as a JSON object with both could otherwise break the import's primary key.
    const byKey = new Map();
    for (const [stored, rec] of Object.entries(parsed)) if (isObj(rec)) byKey.set(stored.toLowerCase(), [stored, rec]);
    if (emptyOnly && this._accountCount() !== 0) return;
    if (!byKey.size) {
      this.log.warn('[accounts] accounts.json has no account entries; leaving it untouched');
      return;
    }
    this._tx(() => {
      for (const [stored, rec] of byKey.values()) this._insertLegacy(stored, rec);
    });
    const imported = `${this.legacyFile}.imported`;
    try { await fsp.rename(this.legacyFile, imported); this.log.info(`[accounts] imported ${byKey.size} account(s) from accounts.json → ${imported}`); }
    catch (e) { this.log.warn('[accounts] imported accounts.json but could not rename it', e.message); }
  }

  /**
   * One legacy account record → its rows.
   * @param {string} stored the key as written (the registered spelling is `rec.name`)
   * @param {Record<string, any>} rec
   */
  _insertLegacy(stored, rec) {
    const key = stored.toLowerCase();
    const known = new Set(['name', 'salt', 'hash', 'loadout', 'ops', 'stats', 'statsClearedAt', 'createdAt', 'lastLoginAt', 'token']);
    const extra = Object.fromEntries(Object.entries(rec).filter(([k]) => !known.has(k)));
    const extraJson = Object.keys(extra).length ? JSON.stringify(extra) : null;
    const stats = normalizeStatsPayload(rec.stats) || (isObj(rec.stats) ? rec.stats : null);
    const statsV = stats ? (Number.isFinite(stats.v) ? stats.v : STATS_VERSION) : null;
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO accounts (user_key, name, salt, hash, hash_scheme, token, loadout_saved, ops_saved, stats_v,
        stats_cleared_at, created_at, last_login_at, extra_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      key,
      typeof rec.name === 'string' && rec.name ? rec.name : stored,
      String(rec.salt || ''),
      String(rec.hash || ''),
      SCRYPT_SCHEME,
      typeof rec.token === 'string' && rec.token ? rec.token.toLowerCase() : null,
      isObj(rec.loadout) ? 1 : 0,
      isObj(rec.ops) ? 1 : 0,
      statsV,
      Number.isFinite(rec.statsClearedAt) ? rec.statsClearedAt : null,
      Number(rec.createdAt) || now,
      Number(rec.lastLoginAt) || now,
      extraJson,
    );
    if (isObj(rec.loadout)) {
      const ins = this.db.prepare('INSERT INTO loadout_entries (user_key, chess_id, skill, module) VALUES (?, ?, ?, ?)');
      for (const [chessId, e] of Object.entries(rec.loadout)) {
        if (!isObj(e)) continue;
        ins.run(key, chessId, Number.isFinite(e.skill) && e.skill >= 0 ? Math.trunc(e.skill) : 0, typeof e.module === 'string' ? e.module : null);
      }
    }
    if (isObj(rec.ops)) {
      const ins = this.db.prepare('INSERT INTO loadout_ops (user_key, char_id, potential, cultivate) VALUES (?, ?, ?, ?)');
      for (const [charId, e] of Object.entries(rec.ops)) {
        if (!isObj(e)) continue;
        ins.run(key, charId,
          Number.isFinite(e.potential) ? Math.min(6, Math.max(1, Math.trunc(e.potential))) : POTENTIAL_DEFAULT,
          Number.isFinite(e.cultivate) ? Math.min(3, Math.max(0, Math.trunc(e.cultivate))) : CULTIVATE_DEFAULT);
      }
    }
    if (stats) {
      const ins = this.db.prepare('INSERT OR REPLACE INTO stats_records (user_key, record_id, t, seq, json) VALUES (?, ?, ?, ?, ?)');
      stats.records.forEach((r, i) => {
        const id = recordId(r);
        if (!id) return;
        ins.run(key, id, stampOf(r), i + 1, JSON.stringify(r));
      });
    }
  }

  /** Close the database (tests and `server/index.js`'s close path; Windows keeps the temp dir locked otherwise). */
  close() {
    const db = this.db;
    this.db = null;
    this._loadPromise = null;
    if (!db) return;
    try { db.close(); } catch (e) { this.log.warn('[accounts] close failed', e.message); }
  }

  /** `using store = new AccountStore(...)` support. */
  [Symbol.dispose]() { this.close(); }
}

/** A generated account ID: `sp-` + 6 random bytes (12 hex), 15 chars, typo-safe to copy. */
function newAccountId() {
  return `sp-${crypto.randomBytes(6).toString('hex')}`;
}

/** Whether a `room.loadout` map carries anything at all. @param {Record<string, any>|null} map */
function hasEntries(map) {
  return !!map && typeof map === 'object' && Object.keys(map).length > 0;
}

/** @param {string} file @returns {Promise<boolean>} */
async function fileExists(file) {
  try { await fsp.access(file); return true; } catch { return false; }
}

/**
 * The stored skin selection (`{ [charId]: skinId }`, null = never saved, {} = saved empty). A manually damaged value is
 * logged and treated as no copy rather than taking the account down.
 * @param {unknown} raw @param {object} log @param {string} key
 */
function parseSkinsJson(raw, log, key) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (isSkinSelection(parsed)) return parsed;
    log.warn(`[accounts] unusable skin selection for ${key}`);
    return null;
  } catch (e) {
    log.warn(`[accounts] unreadable skin selection for ${key}`, e.message);
    return null;
  }
}

/**
 * Parse a JSON object column, or null. A bad value is logged and ignored rather than taking the account down.
 * @param {unknown} raw @param {object} log @param {string} what
 */
function parseJsonObject(raw, log, what) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isObj(parsed) ? parsed : null;
  } catch (e) {
    log.warn(`[accounts] unreadable ${what}`, e.message);
    return null;
  }
}
