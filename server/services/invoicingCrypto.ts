import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const raw = process.env.INVOICING_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error('INVOICING_ENCRYPTION_KEY no está configurada');
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new Error('INVOICING_ENCRYPTION_KEY no es base64 válido');
  }
  if (key.length !== 32) {
    throw new Error(`INVOICING_ENCRYPTION_KEY debe ser 32 bytes (recibí ${key.length})`);
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // layout: IV (12) || ciphertext (n) || authTag (16)
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const key = getKey();
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('Payload cifrado inválido (largo insuficiente)');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(buf.length - AUTH_TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - AUTH_TAG_LENGTH);
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Payload cifrado inválido (auth tag con largo inesperado)');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

export function isInvoicingCryptoConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}
