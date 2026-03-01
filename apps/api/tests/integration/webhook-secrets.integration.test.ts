import assert from 'node:assert/strict';
import test from 'node:test';

import { decryptWebhookSecret, encryptWebhookSecret, isEncryptedWebhookSecret } from '../../src/lib/webhook-secrets.js';

test('webhook secret encryption roundtrip succeeds', () => {
  const plaintext = 'super-secret-value';
  const encryptionKey = '0123456789abcdef0123456789abcdef';

  const encrypted = encryptWebhookSecret(plaintext, encryptionKey);
  assert.match(encrypted, /^enc:v1:/);
  assert.equal(isEncryptedWebhookSecret(encrypted), true);

  const decrypted = decryptWebhookSecret(encrypted, encryptionKey);
  assert.equal(decrypted, plaintext);
});

test('webhook secret decryption supports legacy plaintext storage', () => {
  const plaintext = 'legacy-plaintext-secret';
  const decrypted = decryptWebhookSecret(plaintext, 'unused-key');
  assert.equal(decrypted, plaintext);
  assert.equal(isEncryptedWebhookSecret(plaintext), false);
});
