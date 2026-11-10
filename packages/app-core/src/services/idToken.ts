/**
 * Display-name extraction from a Google OpenID Connect id token (R18.2, D17).
 *
 * SECURITY: the signature is NOT verified. The result is for greeting text
 * only and must never be used for authorization or identity decisions.
 *
 * Hermes may lack `atob` and `TextDecoder`, so base64url and UTF-8 are
 * decoded by hand. Every malformed input yields `undefined`; nothing throws.
 */

/** Longest name kept, in UTF-16 code units trimmed on a code-point boundary. */
export const MAX_GIVEN_NAME_LENGTH = 40;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Decode base64 or base64url (padding optional) to bytes; `null` if invalid. */
function base64UrlToBytes(input: string): number[] | null {
  const s = input.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (s.length % 4 === 1) return null;
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64.indexOf(s.charAt(i));
    if (v < 0) return null;
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return bytes;
}

/** Strict UTF-8 decode; `null` on invalid sequences. */
function utf8Decode(bytes: readonly number[]): string | null {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++]!;
    let cp: number;
    let extra: number;
    let min: number;
    if (b < 0x80) {
      cp = b;
      extra = 0;
      min = 0;
    } else if (b >= 0xc2 && b <= 0xdf) {
      cp = b & 0x1f;
      extra = 1;
      min = 0x80;
    } else if (b >= 0xe0 && b <= 0xef) {
      cp = b & 0x0f;
      extra = 2;
      min = 0x800;
    } else if (b >= 0xf0 && b <= 0xf4) {
      cp = b & 0x07;
      extra = 3;
      min = 0x10000;
    } else {
      return null;
    }
    for (let k = 0; k < extra; k++) {
      const c = bytes[i++];
      if (c === undefined || (c & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** Trim, drop control characters, collapse whitespace, cap length. */
function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  const trimmed = stripped.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  const capped = Array.from(trimmed).slice(0, MAX_GIVEN_NAME_LENGTH).join("").trim();
  return capped || undefined;
}

/**
 * The user's given name from an id token: `given_name`, else the first word
 * of `name`, else `undefined`. Never throws. Signature is not verified.
 */
export function givenNameFromIdToken(
  idToken: string | undefined | null,
): string | undefined {
  try {
    if (typeof idToken !== "string") return undefined;
    const parts = idToken.trim().split(".");
    if (parts.length < 2 || !parts[1]) return undefined;
    const bytes = base64UrlToBytes(parts[1]);
    if (!bytes) return undefined;
    const text = utf8Decode(bytes);
    if (text === null) return undefined;
    const claims: unknown = JSON.parse(text);
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) {
      return undefined;
    }
    const c = claims as Record<string, unknown>;
    const given = cleanName(c.given_name);
    if (given) return given;
    const full = cleanName(c.name);
    if (full) return cleanName(full.split(" ")[0]);
    // Last resort: the email's local part ("rucha.acharya@x" -> "Rucha").
    if (typeof c.email === "string") {
      const local = c.email.split("@")[0] ?? "";
      const first = cleanName(local.split(/[._]/)[0]);
      if (first) {
        const [head = "", ...rest] = Array.from(first);
        return head.toUpperCase() + rest.join("");
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The unverified claims object of a JWT, or `undefined` when malformed. Never throws. */
function claimsOf(idToken: string | undefined | null): Record<string, unknown> | undefined {
  try {
    if (typeof idToken !== "string") return undefined;
    const parts = idToken.trim().split(".");
    if (parts.length < 2 || !parts[1]) return undefined;
    const bytes = base64UrlToBytes(parts[1]);
    if (!bytes) return undefined;
    const text = utf8Decode(bytes);
    if (text === null) return undefined;
    const claims: unknown = JSON.parse(text);
    if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return undefined;
    return claims as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * The `sub` claim (Google account id) of an id token, or `undefined`.
 * Shown to the owner so it can be put on the AI allow-list (R35.1).
 * Signature is not verified; display use only.
 */
export function subFromIdToken(idToken: string | undefined | null): string | undefined {
  const sub = claimsOf(idToken)?.sub;
  return typeof sub === "string" && sub.length > 0 && sub.length <= 255 ? sub : undefined;
}

/** The `exp` claim of an id token in epoch SECONDS, or `undefined`. */
export function expFromIdToken(idToken: string | undefined | null): number | undefined {
  const exp = claimsOf(idToken)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp : undefined;
}
