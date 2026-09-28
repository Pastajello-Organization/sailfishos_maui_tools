import * as fs from 'fs';
import * as vscode from 'vscode';
import { describe, Device, DeviceStore } from './devices';
import { ensureKey, loadKey } from './keys';
import * as remote from './remoteScripts';
import { HostKeyCheck, SshConnection, SshError } from './ssh';

export interface DeviceInfo {
  sailfish: boolean;
  /** e.g. "Sailfish OS 5.0.0.62" */
  pretty: string;
  arch: string;
}

/** Opens sessions to a stored device: key first, the developer-mode password as the fallback. */
export class Connector {
  constructor(private readonly store: DeviceStore) {}

  /** Trust on first use; a changed key is refused unless the user accepts the new one. */
  private hostKeyCheck(device: Device): HostKeyCheck {
    return async fingerprint => {
      const pinned = this.store.pinnedHostKey(device);
      if (pinned === fingerprint) {
        return true;
      }
      const trust = pinned ? 'Trust the New Key' : 'Trust';
      const detail = pinned
        ? `The host key of ${device.host} changed.\n\nPinned: ${pinned}\nNow:    ${fingerprint}\n\n` +
          'Expected after reflashing the phone; otherwise something else answers on that address.'
        : `First connection to ${device.host}.\n\nHost key: ${fingerprint}\n\n` +
          'On the phone: Settings > Developer tools shows the same address.';
      const answer = await vscode.window.showWarningMessage(
        pinned ? 'Sailfish device host key changed' : 'Trust this Sailfish device?', { modal: true, detail }, trust);
      if (answer !== trust) {
        return false;
      }
      await this.store.pinHostKey(device, fingerprint);
      return true;
    };
  }

  /** Key or ssh-agent login, which the debugger pipe needs too. */
  connectWithKey(device: Device): Promise<SshConnection> {
    const key = loadKey();
    const agent = process.env.SSH_AUTH_SOCK && fs.existsSync(process.env.SSH_AUTH_SOCK) ? process.env.SSH_AUTH_SOCK : undefined;
    if (!key && !agent) {
      return Promise.reject(new SshError('no SSH key yet', 'auth'));
    }
    return SshConnection.open(device, { privateKey: key?.privateKey, agent }, this.hostKeyCheck(device));
  }

  connectWithPassword(device: Device, password: string): Promise<SshConnection> {
    return SshConnection.open(device, { password }, this.hostKeyCheck(device));
  }

  /** Key first; on a rejected key the stored password, or (when allowed) one asked for now. */
  async connect(device: Device, askForPassword = true): Promise<SshConnection> {
    try {
      return await this.connectWithKey(device);
    } catch (err) {
      if (!(err instanceof SshError) || err.kind !== 'auth') {
        throw err;
      }
    }
    let password = await this.store.password(device);
    if (!password && askForPassword) {
      password = await askPassword(device);
      if (password) {
        await this.store.setPassword(device, password);
      }
    }
    if (!password) {
      throw new SshError(`${describe(device)} needs a paired key or the developer-mode password`, 'auth');
    }
    return this.connectWithPassword(device, password);
  }

  /**
   * Installs the public key on the phone (what ssh-copy-id did), generating one if needed, and proves a key-only
   * login works afterwards.
   */
  async pair(device: Device, password?: string): Promise<void> {
    const { key } = ensureKey();
    password ??= await this.store.password(device) ?? await askPassword(device);
    if (!password) {
      throw new Error('pairing needs the developer-mode password once');
    }
    const session = await this.connectWithPassword(device, password);
    try {
      const result = await session.script(remote.authorizeKey(key.publicLine));
      if (!result.stdout.includes('AUTHORIZED')) {
        throw new Error(`could not install the key: ${(result.stderr || result.stdout).trim()}`);
      }
    } finally {
      session.close();
    }
    await this.store.setPassword(device, password);
    const check = await this.connectWithKey(device);
    check.close();
  }
}

export async function probe(session: SshConnection): Promise<DeviceInfo> {
  const result = await session.exec(remote.osRelease);
  const fields = new Map<string, string>();
  for (const line of result.stdout.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) {
      fields.set(match[1], match[2].replace(/^"(.*)"$/, '$1'));
    }
  }
  return {
    sailfish: fields.get('ID') === 'sailfishos',
    pretty: fields.get('PRETTY_NAME') ?? fields.get('NAME') ?? 'unknown OS',
    arch: fields.get('ARCH') ?? '',
  };
}

export function askPassword(device: Device): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: `Developer-mode password for ${describe(device)}`,
    prompt: 'Settings > Developer tools > Remote connection on the phone. Stored in the system keychain.',
    password: true,
    ignoreFocusOut: true,
  });
}
