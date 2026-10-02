// Copyright (c) 2026 Doforu
// Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only).
//     See the LICENSE file or https://www.gnu.org/licenses/agpl-3.0.txt
/**
 * API Key 工具函数
 * 格式：mb_ + 48 位十六进制字符（24 字节随机数）
 * 示例：mb_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2
 */

// 使用 Web Crypto API（Cloudflare Workers 环境可用）
async function generateKeyMaterial(): Promise<Uint8Array> {
  const key = crypto.getRandomValues(new Uint8Array(24));
  return key;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  const hashArray = new Uint8Array(hashBuffer);
  return bytesToHex(hashArray);
}

export interface GeneratedApiKey {
  /** 完整的明文 API Key，例如 mb_a1b2...。仅生成时返回一次 */
  plainText: string;
  /** 前缀（前 11 位）：mb_ + 前 8 位 hex，用于数据库索引和日志识别 */
  prefix: string;
  /** SHA-256 哈希值，存入数据库 */
  hash: string;
}

/**
 * 生成一个新的 API Key
 * - 格式：mb_ + 48 位随机十六进制字符
 * - 返回明文（仅此一次）、前缀（用于索引）、哈希（用于存储）
 */
export async function generateApiKey(): Promise<GeneratedApiKey> {
  const material = await generateKeyMaterial();
  const hexPart = bytesToHex(material);
  const plainText = `mb_${hexPart}`;
  const prefix = plainText.substring(0, 11); // "mb_" + 前 8 位
  const hash = await sha256Hash(plainText);

  return { plainText, prefix, hash };
}

/**
 * 验证一个明文 API Key 是否与存储的哈希匹配
 */
export async function verifyApiKey(
  plainTextKey: string,
  storedHash: string,
): Promise<boolean> {
  const hash = await sha256Hash(plainTextKey);
  return hash === storedHash;
}

/**
 * 从 Authorization header 中提取 Bearer token
 * 返回 null 如果格式不正确
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;

  // 先处理 "Bearer mb_xxx" 格式
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    return token.startsWith("mb_") ? token : null;
  }

  // 再处理直接 "mb_xxx" 格式
  if (authHeader.startsWith("mb_")) {
    return authHeader.trim();
  }

  return null;
}

/**
 * 从 API Key 中提取前缀（前 11 位 = "mb_" + 8 位 hex）
 */
export function extractPrefix(plainTextKey: string): string {
  return plainTextKey.substring(0, 11);
}

/**
 * 生成唯一 ID（用于 api_keys 表的主键）
 */
export function generateKeyId(): string {
  const material = crypto.getRandomValues(new Uint8Array(16));
  return bytesToHex(material);
}
