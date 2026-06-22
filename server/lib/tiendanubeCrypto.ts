import crypto from 'crypto';

// Cifrado AES-256-GCM para los access tokens de Tiendanube guardados en la base.
// Mismo patrón que server/services/invoicingCrypto.ts. Clave en base64 (32 bytes)
// en TIENDANUBE_ENCRYPTION_KEY. Si falta, cae a INVOICING_ENCRYPTION_KEY para
// reutilizar la misma clave de cifrado de credenciales de terceros.
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.TIENDANUBE_ENCRYPTION_KEY || process.env.INVOICING_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('TIENDANUBE_ENCRYPTION_KEY (o INVOICING_ENCRYPTION_KEY) no está configurada');
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`La clave de cifrado debe ser 32 bytes en base64 (recibí ${key.length})`);
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64'); // IV || ct || tag
}

export function decryptToken(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('Token cifrado inválido (largo insuficiente)');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(buf.length - AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function isTiendanubeCryptoConfigured(): boolean {
  try { getKey(); return true; } catch { return false; }
}
