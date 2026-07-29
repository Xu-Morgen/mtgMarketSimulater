import { createCipheriv, randomBytes } from "node:crypto";

/** 服务器专用的 AES-256-GCM 封装；调用方负责把 nonce/tag 与密文一同持久化。 */
export function encryptJsonPayload(value: Record<string, unknown>, base64Key: string): { ciphertext: Buffer; nonce: Buffer; tag: Buffer } {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("DECK_RESPONSE_ENCRYPTION_KEY 必须是 32 字节 base64 密钥");
  const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}
