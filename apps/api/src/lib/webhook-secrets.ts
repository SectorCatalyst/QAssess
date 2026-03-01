import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ENCRYPTION_PREFIX = 'enc:v1';
const SEPARATOR = ':';

function toBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

function deriveAes256Key(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function isEncryptedWebhookSecret(value: string): boolean {
  return value.startsWith(`${ENCRYPTION_PREFIX}${SEPARATOR}`);
}

export function encryptWebhookSecret(plaintext: string, encryptionKey: string): string {
  if (plaintext.length === 0) {
    throw new Error('Webhook secret cannot be empty');
  }

  const key = deriveAes256Key(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENCRYPTION_PREFIX,
    toBase64Url(iv),
    toBase64Url(authTag),
    toBase64Url(ciphertext)
  ].join(SEPARATOR);
}

export function decryptWebhookSecret(storedSecret: string, encryptionKey: string): string {
  if (!isEncryptedWebhookSecret(storedSecret)) {
    // Backward compatibility for pre-encryption records.
    return storedSecret;
  }

  const parts = storedSecret.split(SEPARATOR);
  if (parts.length !== 5 || parts[0] !== 'enc' || parts[1] !== 'v1') {
    throw new Error('Webhook secret payload has invalid format');
  }

  const ivPart = parts[2];
  const authTagPart = parts[3];
  const ciphertextPart = parts[4];

  if (!ivPart || !authTagPart || !ciphertextPart) {
    throw new Error('Webhook secret payload is incomplete');
  }

  const key = deriveAes256Key(encryptionKey);
  const decipher = createDecipheriv('aes-256-gcm', key, fromBase64Url(ivPart));
  decipher.setAuthTag(fromBase64Url(authTagPart));

  const plaintext = Buffer.concat([
    decipher.update(fromBase64Url(ciphertextPart)),
    decipher.final()
  ]);

  return plaintext.toString('utf8');
}
