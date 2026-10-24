// shared/account.js — the two names of an account (extension §account):
//
//   * the ACCOUNT ID is what signs in. It is assigned once (server/accounts.js: generated for a new account, the old
//     username for an account migrated from the username-as-login era) and never changes. A player may copy it from
//     the title screen / settings; it is not a display name.
//   * the USERNAME is the in-game name (what the room, the match and the statistics show). It may be changed at any
//     time, is NOT unique and is NOT a credential — two accounts may share one.
//
// This module is the shared shape check for both: the browser sanitises a typed username before sending it, the
// server sanitises it again (never trusting the client), and the protocol validator only checks the envelope.

/** Longest display username, in Unicode code points (the old username limit was 24 code units). */
export const ACCOUNT_NAME_MAX = 24;
/**
 * Account IDs are typed by hand: lowercase ASCII, 2–64 chars, dots / underscores / hyphens allowed — including as the
 * first character, because the old username-as-login rule allowed `_alice` / `-alice` and those are migrated IDs.
 */
export const ACCOUNT_ID_RE = /^[a-z0-9_.-][a-z0-9._-]{1,63}$/;

// Same character classes as server/net.js sanitizeName (control, zero-width, bidi, BOM), so a name the client accepts
// is never rejected by the server's own sanitizer.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Remove lone surrogates without a regex lookbehind (Safari < 16.4 has no lookbehind syntax). */
function stripLoneSurrogates(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (n >= 0xdc00 && n <= 0xdfff) { out += str[i] + str[i + 1]; i++; }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += str[i];
  }
  return out;
}

/**
 * A display username as this build stores it: NFC, no control / invisible / bidi characters or lone surrogates,
 * whitespace collapsed, trimmed, at most ACCOUNT_NAME_MAX code points. '' when nothing printable remains.
 * Unlike the in-game callsign (NAME_MAX_LEN = 12) an account username may be 24 code points, and unlike the old
 * username-as-login rule it may be any script (Chinese, spaces included).
 * @param {any} raw
 * @returns {string}
 */
export function sanitizeAccountName(raw) {
  let s = String(raw ?? '');
  try { s = s.normalize('NFC'); } catch { /* keep as is */ }
  s = stripLoneSurrogates(s).replace(/\s+/g, ' ').replace(CONTROL_CHARS, '').replace(/ {2,}/g, ' ').trim();
  s = [...s].slice(0, ACCOUNT_NAME_MAX).join('').trim();
  return s;
}

/** @param {any} raw @returns {boolean} */
export const isAccountName = (raw) => sanitizeAccountName(raw).length > 0;

/**
 * An account ID as typed by the player: trimmed, lowercased, and null unless it has the stored shape. The old
 * username-as-login keys (`mr.hate`, `test`) are valid IDs, so an existing player signs in with the username they
 * used before the split.
 * @param {any} raw
 * @returns {string | null}
 */
export function normalizeAccountId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  return ACCOUNT_ID_RE.test(id) ? id : null;
}

/** @param {any} raw @returns {boolean} */
export const isAccountId = (raw) => normalizeAccountId(raw) != null;
