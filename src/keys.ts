import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { utils } from 'ssh2';

export interface SshKey {
  privatePath: string;
  privateKey: Buffer;
  /** One authorized_keys line. */
  publicLine: string;
}

/** The configured key, else ~/.ssh/id_ed25519 when present, else a dedicated key the extension owns. */
export function keyPath(): string {
  const configured = vscode.workspace.getConfiguration('mauiSailfish').get<string>('sshKeyPath', '').trim();
  if (configured) {
    return configured.replace(/^~(?=$|\/)/, os.homedir());
  }
  const standard = path.join(os.homedir(), '.ssh', 'id_ed25519');
  if (fs.existsSync(standard)) {
    return standard;
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'maui-sailfish', 'id_ed25519');
}

/** Loads the key if it exists and is usable without a passphrase (encrypted keys go through ssh-agent instead). */
export function loadKey(): SshKey | undefined {
  const privatePath = keyPath();
  if (!fs.existsSync(privatePath)) {
    return undefined;
  }
  const privateKey = fs.readFileSync(privatePath);
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) {
    return undefined;
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  const publicPath = `${privatePath}.pub`;
  const publicLine = fs.existsSync(publicPath)
    ? fs.readFileSync(publicPath, 'utf8').trim()
    : `${key.type} ${key.getPublicSSH().toString('base64')} maui-sailfish`;
  return { privatePath, privateKey, publicLine };
}

/** Returns the key, generating an ed25519 pair first when there is none; an existing file is never overwritten. */
export function ensureKey(): { key: SshKey; created: boolean } {
  const existing = loadKey();
  if (existing) {
    return { key: existing, created: false };
  }
  const privatePath = keyPath();
  if (fs.existsSync(privatePath)) {
    throw new Error(`${privatePath} cannot be used without a passphrase; load it into ssh-agent, or set mauiSailfish.sshKeyPath to another key`);
  }
  const pair = utils.generateKeyPairSync('ed25519', { comment: `maui-sailfish@${os.hostname()}` });
  fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(privatePath, pair.private, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(`${privatePath}.pub`, pair.public + '\n', { mode: 0o644, flag: 'wx' });
  return { key: loadKey()!, created: true };
}

/** "SHA256:…" of an authorized_keys line, as ssh-keygen -l prints it. */
export function publicFingerprint(publicLine: string): string {
  const blob = Buffer.from(publicLine.split(/\s+/)[1] ?? '', 'base64');
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}
