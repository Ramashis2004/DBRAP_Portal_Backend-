const crypto = require("crypto");

const STATIC_IV = "fedcba9876543210";

/**
 * Normalizes key to 16 bytes (128 bits) per Odisha One spec:
 * - If shorter than 16, pad with '0'
 * - If longer than 16, truncate to 16
 */
function normalizeKey(key) {
  let strKey = String(key || "");
  if (strKey.length < 16) {
    strKey = strKey.padEnd(16, "0");
  } else if (strKey.length > 16) {
    strKey = strKey.substring(0, 16);
  }
  return Buffer.from(strKey, "utf-8");
}

/**
 * Encrypts plain text string using AES-128-CBC with fixed IV and returns `Base64Data:Base64IV`
 */
function encrypt(key, data) {
  if (data === null || data === undefined) return null;
  const dataStr = typeof data === "string" ? data : JSON.stringify(data);
  const normKey = normalizeKey(key);
  const ivBuf = Buffer.from(STATIC_IV, "utf-8");
  const cipher = crypto.createCipheriv("aes-128-cbc", normKey, ivBuf);
  cipher.setAutoPadding(true);

  let encrypted = cipher.update(dataStr, "utf-8", "base64");
  encrypted += cipher.final("base64");

  const base64Iv = ivBuf.toString("base64");
  return `${encrypted}:${base64Iv}`;
}

/**
 * Decrypts `Base64Data:Base64IV` payload using AES-128-CBC
 */
function decrypt(key, encPayload) {
  if (!encPayload || typeof encPayload !== "string") return null;
  const parts = encPayload.split(":");
  if (parts.length < 2) return null;

  try {
    const normKey = normalizeKey(key);
    const cipherTextBuf = Buffer.from(parts[0], "base64");
    const ivBuf = Buffer.from(parts[1], "base64");

    const decipher = crypto.createDecipheriv("aes-128-cbc", normKey, ivBuf);
    decipher.setAutoPadding(true);

    let decrypted = decipher.update(cipherTextBuf, undefined, "utf-8");
    decrypted += decipher.final("utf-8");
    return decrypted;
  } catch (error) {
    console.error("Odisha One Decryption Error:", error.message);
    return null;
  }
}

module.exports = {
  encrypt,
  decrypt,
};
