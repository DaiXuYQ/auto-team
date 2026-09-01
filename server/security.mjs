import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ENCRYPTED_STATE_VERSION = 1;

function keyFromInput(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  if (/^[a-f\d]{64}$/i.test(input)) return Buffer.from(input, 'hex');
  try {
    const decoded = Buffer.from(input, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    // Fall through to deriving a stable key from the supplied passphrase.
  }
  return createHash('sha256').update(input, 'utf8').digest();
}

async function localStateKey(dataDir) {
  const keyFile = path.join(dataDir, '.state-key');
  try {
    const key = keyFromInput(await readFile(keyFile, 'utf8'));
    if (key) return key;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(dataDir, { recursive: true });
  const key = randomBytes(32);
  await writeFile(keyFile, key.toString('base64'), { encoding: 'utf8', mode: 0o600, flag: 'wx' }).catch(async (error) => {
    if (error?.code !== 'EEXIST') throw error;
  });
  await chmod(keyFile, 0o600).catch(() => {});
  const stored = keyFromInput(await readFile(keyFile, 'utf8'));
  if (!stored) throw new Error('state_encryption_key_invalid');
  return stored;
}

export async function createStateStorage(dataDir) {
  const key = keyFromInput(process.env.TEAM_ROTATION_DATA_KEY) || await localStateKey(dataDir);
  let legacyPlaintextLoaded = false;
  return {
    get legacyPlaintextLoaded() { return legacyPlaintextLoaded; },
    decode(text) {
      const parsed = JSON.parse(text);
      if (parsed?.encrypted !== true) {
        legacyPlaintextLoaded = true;
        return parsed;
      }
      if (parsed.version !== ENCRYPTED_STATE_VERSION || parsed.algorithm !== 'aes-256-gcm') throw new Error('state_encryption_format_unsupported');
      try {
        const iv = Buffer.from(String(parsed.iv || ''), 'base64');
        const tag = Buffer.from(String(parsed.tag || ''), 'base64');
        const ciphertext = Buffer.from(String(parsed.ciphertext || ''), 'base64');
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
      } catch (error) {
        const wrapped = new Error('state_decryption_failed');
        wrapped.code = 'STATE_DECRYPTION_FAILED';
        wrapped.cause = error;
        throw wrapped;
      }
    },
    encode(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
      return JSON.stringify({
        version: ENCRYPTED_STATE_VERSION,
        encrypted: true,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }, null, 2);
    },
  };
}

export function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function secureTokenEqual(left, right) {
  const supplied = Buffer.from(String(left || ''), 'utf8');
  const expected = Buffer.from(String(right || ''), 'utf8');
  return supplied.length === expected.length && supplied.length > 0 && timingSafeEqual(supplied, expected);
}
