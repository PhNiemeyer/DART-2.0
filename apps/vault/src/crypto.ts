import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';

/** AES-256-GCM: [12 Byte IV | 16 Byte Tag | Chiffrat] */
export function encrypt(key: Buffer, plain: Buffer | string, aad = 'dart-vault-v1'): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(typeof plain === 'string' ? Buffer.from(plain, 'utf8') : plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

export function decrypt(key: Buffer, blob: Buffer, aad = 'dart-vault-v1'): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(28)), d.final()]);
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function normalizeName(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z]/g, '');
}

export function nameIndex(key: Buffer, lastName: string): string {
  return createHmac('sha256', key).update(normalizeName(lastName)).digest('hex');
}

/** Persönlicher Zugangscode: 8 Zeichen ohne verwechselbare Zeichen. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newAccessCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export function hashSecret(secret: string): string {
  const salt = randomBytes(16);
  const h = scryptSync(secret.toUpperCase().replace(/[\s-]/g, ''), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}

export function verifySecret(secret: string, stored: string): boolean {
  const [alg, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const h = scryptSync(secret.toUpperCase().replace(/[\s-]/g, ''), Buffer.from(saltB64, 'base64'), 32, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hashB64, 'base64');
  return expected.length === h.length && timingSafeEqual(expected, h);
}
