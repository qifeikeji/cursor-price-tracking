import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Chromium v10/v11 cookie blob (Linux/Electron often uses v10 + AES-GCM). */
export function decryptChromiumCookieValue(encrypted: Uint8Array, localStatePath?: string): string | null {
    const buf = Buffer.from(encrypted);
    if (buf.length < 31) {
        return null;
    }

    const prefix = buf.subarray(0, 3).toString('utf8');
    if (prefix !== 'v10' && prefix !== 'v11') {
        return null;
    }

    const keys = collectDecryptionKeys(localStatePath);
    const nonce = buf.subarray(3, 15);
    const tag = buf.subarray(buf.length - 16);
    const ciphertext = buf.subarray(15, buf.length - 16);

    for (const key of keys) {
        try {
            const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
            decipher.setAuthTag(tag);
            const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
            return plain.toString('utf8');
        } catch {
            // try next key
        }
    }

    return null;
}

function collectDecryptionKeys(localStatePath?: string): Buffer[] {
    const keys: Buffer[] = [];

    keys.push(crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1'));

    if (localStatePath && fs.existsSync(localStatePath)) {
        try {
            const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8')) as {
                os_crypt?: { encrypted_key?: string };
            };
            const encoded = localState.os_crypt?.encrypted_key;
            if (encoded) {
                const raw = Buffer.from(encoded, 'base64');
                // Linux: skip optional prefix bytes after base64 decode when present
                const keyMaterial = raw.length > 32 ? raw.subarray(raw.length - 32) : raw;
                if (keyMaterial.length === 32) {
                    keys.push(keyMaterial.subarray(0, 16));
                    keys.push(keyMaterial.subarray(16, 32));
                } else if (keyMaterial.length >= 16) {
                    keys.push(keyMaterial.subarray(0, 16));
                }
            }
        } catch {
            // ignore Local State parse errors
        }
    }

    return keys;
}

export function resolveLocalStatePath(cookiesDbPath: string): string {
    let profileDir = path.dirname(cookiesDbPath);
    if (path.basename(profileDir) === 'Network') {
        profileDir = path.dirname(profileDir);
    }
    return path.join(profileDir, 'Local State');
}
