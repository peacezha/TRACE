// ============================================================================
//  TOTP Secret Storage & Code Generator
//  Google Authenticator compatible - RFC 6238 / RFC 4226
//  Uses Web Crypto API (HMAC-SHA1) — no external dependencies
// ============================================================================

import { desktopSecrets } from "./desktopSecrets";
import { isPublicWeb } from './publicWeb';

const TOTP_SECRET_STORAGE_KEY = "trace_totp_secret";
const TOTP_REMEMBER_KEY = "trace_remember_me";

// Default embedded secret — replace with your own


// ——— Base32 decoder (RFC 4648, uppercase, no padding) ———
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const base32DecodeMap: Record<string, number> = {};
for (let i = 0; i < BASE32_ALPHABET.length; i++) {
  base32DecodeMap[BASE32_ALPHABET[i]] = i;
}

function base32Decode(encoded: string): Uint8Array {
  const cleaned = encoded.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  const bits: number[] = [];
  for (const ch of cleaned) {
    const val = base32DecodeMap[ch];
    if (val === undefined) continue; // skip invalid chars
    for (let b = 4; b >= 0; b--) bits.push((val >> b) & 1);
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[i * 8 + b] ?? 0);
    bytes[i] = byte;
  }
  return bytes;
}

// ——— Counter buffer (8-byte big-endian) ———
function counterBuffer(counter: number): Uint8Array {
  const buf = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  return buf;
}

// ——— Dynamic truncation (RFC 4226 §5.4) ———
function dynamicTruncate(hmac: Uint8Array): number {
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return bin % 1_000_000;
}


// --- Pure JS SHA1 + HMAC-SHA1 (fallback when crypto.subtle unavailable) ---
function rotl32(x: number, n: number): number { return ((x << n) | (x >>> (32 - n))) >>> 0; }

function sha1(msg: Uint8Array): Uint8Array {
  const ml = msg.length * 8;
  const padded = new Uint8Array(Math.ceil((msg.length + 9) / 64) * 64);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const lenIdx = padded.length - 8;
  padded[lenIdx + 4] = (ml >>> 24) & 0xff;
  padded[lenIdx + 5] = (ml >>> 16) & 0xff;
  padded[lenIdx + 6] = (ml >>> 8) & 0xff;
  padded[lenIdx + 7] = ml & 0xff;

  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  for (let off = 0; off < padded.length; off += 64) {
    const w = new Uint32Array(80);
    for (let i = 0; i < 16; i++) {
      w[i] = (padded[off + i*4] << 24) | (padded[off + i*4 + 1] << 16) | (padded[off + i*4 + 2] << 8) | padded[off + i*4 + 3];
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl32(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      const temp = (rotl32(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl32(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const words = [h0, h1, h2, h3, h4];
  for (let i = 0; i < 5; i++) {
    out[i*4] = (words[i] >>> 24) & 0xff; out[i*4+1] = (words[i] >>> 16) & 0xff;
    out[i*4+2] = (words[i] >>> 8) & 0xff; out[i*4+3] = words[i] & 0xff;
  }
  return out;
}

function hmacSha1(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const BLOCK = 64;
  let k = key;
  if (k.length > BLOCK) k = sha1(k);
  const keyPad = new Uint8Array(BLOCK);
  keyPad.set(k);
  const iPad = new Uint8Array(BLOCK);
  const oPad = new Uint8Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) { iPad[i] = keyPad[i] ^ 0x36; oPad[i] = keyPad[i] ^ 0x5c; }
  const innerMsg = new Uint8Array(BLOCK + msg.length);
  innerMsg.set(iPad); innerMsg.set(msg, BLOCK);
  const innerHash = sha1(innerMsg);
  const outerMsg = new Uint8Array(BLOCK + 20);
  outerMsg.set(oPad); outerMsg.set(innerHash, BLOCK);
  return sha1(outerMsg);
}
// ——— Generate a 6-digit TOTP code ———
export async function generateTOTP(secret: string, period = 30): Promise<string> {
  const keyBytes = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / period);
  const counterBytes = counterBuffer(counter);

  let sig: Uint8Array;
  try {
    // Try Web Crypto API first (fast, hardware-backed)
    const cryptoKey = await crypto.subtle.importKey(
      "raw", keyBytes,
      { name: "HMAC", hash: "SHA-1" },
      false, ["sign"],
    );
    sig = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, counterBytes));
  } catch {
    // Fallback: pure JS HMAC-SHA1 (works on any origin, HTTP or HTTPS)
    sig = hmacSha1(keyBytes, counterBytes);
  }
  const otp = dynamicTruncate(sig);
  return otp.toString().padStart(6, "0");
}

// ——— Secret key management ———
// 桌面端密文存 safeStorage 加密存储（secret-store 白名单 key: totpSecret），
// 内存缓存 + 启动时 hydrateTotpStorage 水合；浏览器开发模式回退 localStorage。
let totpSecretCache: string | null = null;

export function getStoredSecret(): string {
  if (isPublicWeb()) return '';
  if (totpSecretCache !== null) return totpSecretCache;
  if (desktopSecrets()) return '';
  try {
    const stored = localStorage.getItem(TOTP_SECRET_STORAGE_KEY);
    if (stored) return stored;
  } catch { /* localStorage unavailable */ }
  return "";
}

export function storeSecret(secret: string): void {
  if (isPublicWeb()) return;
  const desktop = desktopSecrets();
  if (desktop) {
    totpSecretCache = secret;
    const write = secret ? desktop.set("totpSecret", secret) : desktop.delete("totpSecret");
    write.catch(err => {
      console.warn("[totpStorage] 加密存储写入失败，仅保留内存值:", err);
      window.dispatchEvent(new CustomEvent('trace-persistence-error', {
        detail: 'TOTP 种子保存到桌面加密存储失败，当前仅在内存中生效，重启后需重新配置。',
      }));
    });
    return;
  }
  try {
    localStorage.setItem(TOTP_SECRET_STORAGE_KEY, secret);
  } catch { /* localStorage unavailable */ }
}

// ——— Remember-me state ———
export function getRememberMe(): boolean {
  if (isPublicWeb()) return false;
  try {
    return localStorage.getItem(TOTP_REMEMBER_KEY) === "1";
  } catch {
    return false;
  }
}

export function setRememberMe(remember: boolean): void {
  if (isPublicWeb()) return;
  try {
    if (remember) {
      localStorage.setItem(TOTP_REMEMBER_KEY, "1");
    } else {
      localStorage.removeItem(TOTP_REMEMBER_KEY);
    }
  } catch { /* localStorage unavailable */ }
}

// ——— Saved credentials (only when remember-me is active) ———
// 记住的集群密码：桌面端走 safeStorage 加密存储（白名单 key: clusterPassword），
// 内存缓存 + 启动时水合；浏览器开发模式回退 localStorage。
const SAVED_PASSWORD_KEY = "trace_saved_password";
let savedPasswordCache: string | null = null;

export function getSavedPassword(): string {
  if (isPublicWeb()) return '';
  if (savedPasswordCache !== null) return savedPasswordCache;
  if (desktopSecrets()) return '';
  try {
    return localStorage.getItem(SAVED_PASSWORD_KEY) || "";
  } catch {
    return "";
  }
}

export function savePassword(password: string): void {
  if (isPublicWeb()) return;
  const desktop = desktopSecrets();
  if (desktop) {
    savedPasswordCache = password;
    const write = password ? desktop.set("clusterPassword", password) : desktop.delete("clusterPassword");
    write.catch(err => {
      console.warn("[totpStorage] 加密存储写入失败，仅保留内存值:", err);
      window.dispatchEvent(new CustomEvent('trace-persistence-error', {
        detail: '集群密码保存到桌面加密存储失败，当前仅在内存中生效，重启后需重新输入。',
      }));
    });
    return;
  }
  try {
    if (password) {
      localStorage.setItem(SAVED_PASSWORD_KEY, password);
    } else {
      localStorage.removeItem(SAVED_PASSWORD_KEY);
    }
  } catch { /* localStorage unavailable */ }
}

export function clearSavedCredentials(): void {
  const desktop = desktopSecrets();
  if (desktop) {
    savedPasswordCache = "";
    desktop.delete("clusterPassword").catch(() => {});
  }
  try {
    localStorage.removeItem(SAVED_PASSWORD_KEY);
    localStorage.removeItem(TOTP_REMEMBER_KEY);
    // Keep the secret key — it's the app config, not user data
  } catch { /* localStorage unavailable */ }
}

// ——— 启动水合：桌面端从加密存储读入缓存，并把 localStorage 历史明文搬迁过去 ———
export async function hydrateTotpStorage(): Promise<void> {
  if (isPublicWeb()) {
    for (const key of [TOTP_SECRET_STORAGE_KEY, SAVED_PASSWORD_KEY, TOTP_REMEMBER_KEY]) localStorage.removeItem(key);
    totpSecretCache = ''; savedPasswordCache = ''; return;
  }
  const desktop = desktopSecrets();
  if (!desktop) return;
  try {
    const storedSecret = await desktop.get("totpSecret");
    if (storedSecret) {
      totpSecretCache = storedSecret;
      localStorage.removeItem(TOTP_SECRET_STORAGE_KEY); // 清历史明文
    } else {
      const legacySecret = localStorage.getItem(TOTP_SECRET_STORAGE_KEY) || "";
      if (legacySecret) {
        await desktop.set("totpSecret", legacySecret);
        localStorage.removeItem(TOTP_SECRET_STORAGE_KEY);
      }
      totpSecretCache = legacySecret;
    }
    const storedPassword = await desktop.get("clusterPassword");
    if (storedPassword) {
      savedPasswordCache = storedPassword;
      localStorage.removeItem(SAVED_PASSWORD_KEY);
    } else {
      const legacyPassword = localStorage.getItem(SAVED_PASSWORD_KEY) || "";
      if (legacyPassword) {
        await desktop.set("clusterPassword", legacyPassword);
        localStorage.removeItem(SAVED_PASSWORD_KEY);
      }
      savedPasswordCache = legacyPassword;
    }
  } catch (err) {
    // 生产桌面端不得因 safeStorage 故障回退到 localStorage 明文。
    totpSecretCache = '';
    savedPasswordCache = '';
    console.warn("[totpStorage] 加密存储水合失败，仅使用内存值:", err);
    window.dispatchEvent(new CustomEvent('trace-persistence-error', {
      detail: '桌面加密存储不可用，TOTP 种子和集群密码仅保留在当前内存中，不会读取或写入明文存储。',
    }));
  }
}
