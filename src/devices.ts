import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectInfo, parseConnectInfo } from './connectInfo';

export interface Device {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
}

const DEVICES = 'mauiSailfish.devices';
const CURRENT = 'mauiSailfish.currentDevice';
const HOST_KEYS = 'mauiSailfish.hostKeys';

/**
 * The phones this user works with, shared by every workspace; which one is active is remembered per workspace
 * (falling back to the last one used anywhere). Passwords live in SecretStorage (the OS keychain), host key
 * fingerprints are pinned on first connection so a changed key fails loudly.
 */
export class DeviceStore {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento, private readonly workspace: vscode.Memento,
              private readonly secrets: vscode.SecretStorage) {}

  list(): Device[] {
    return this.state.get<Device[]>(DEVICES, []);
  }

  current(): Device | undefined {
    const devices = this.list();
    const id = this.workspace.get<string>(CURRENT) ?? this.state.get<string>(CURRENT);
    return devices.find(d => d.id === id) ?? devices[0];
  }

  async select(id: string): Promise<void> {
    await this.workspace.update(CURRENT, id);
    await this.state.update(CURRENT, id);
    this.changed.fire();
  }

  async save(device: Device, password?: string): Promise<void> {
    const others = this.list().filter(d => d.id !== device.id);
    await this.state.update(DEVICES, [...others, device]);
    if (password !== undefined) {
      await this.setPassword(device, password);
    }
    await this.select(device.id);
  }

  async remove(device: Device): Promise<void> {
    await this.state.update(DEVICES, this.list().filter(d => d.id !== device.id));
    await this.secrets.delete(passwordKey(device));
    await this.unpinHostKey(device);
    for (const memento of [this.state, this.workspace]) {
      if (memento.get<string>(CURRENT) === device.id) {
        await memento.update(CURRENT, undefined);
      }
    }
    this.changed.fire();
  }

  password(device: Device): Thenable<string | undefined> {
    return this.secrets.get(passwordKey(device));
  }

  async setPassword(device: Device, password: string): Promise<void> {
    if (password) {
      await this.secrets.store(passwordKey(device), password);
    } else {
      await this.secrets.delete(passwordKey(device));
    }
    this.changed.fire();
  }

  pinnedHostKey(device: Device): string | undefined {
    return this.state.get<Record<string, string>>(HOST_KEYS, {})[endpoint(device)];
  }

  async pinHostKey(device: Device, fingerprint: string): Promise<void> {
    const keys = { ...this.state.get<Record<string, string>>(HOST_KEYS, {}), [endpoint(device)]: fingerprint };
    await this.state.update(HOST_KEYS, keys);
  }

  async unpinHostKey(device: Device): Promise<void> {
    const keys = { ...this.state.get<Record<string, string>>(HOST_KEYS, {}) };
    delete keys[endpoint(device)];
    await this.state.update(HOST_KEYS, keys);
  }
}

export function newDevice(host: string, user: string, port = 22): Device {
  return { id: `${user}@${host}:${port}`, name: host, host, port, user };
}

export function describe(device: Device): string {
  return device.port === 22 ? `${device.user}@${device.host}` : `${device.user}@${device.host}:${device.port}`;
}

function endpoint(device: Device): string {
  return `${device.host}:${device.port}`;
}

function passwordKey(device: Device): string {
  return `mauiSailfish.password.${device.id}`;
}

/** The shell tooling's device file, if one exists: $SF_CONNECT_INFO, the workspace, then ~/.config/maui-sailfish. */
export function findConnectInfo(): { file: string; info: ConnectInfo } | undefined {
  const config = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  const candidates = [
    process.env.SF_CONNECT_INFO,
    ...(vscode.workspace.workspaceFolders ?? []).map(f => path.join(f.uri.fsPath, 'connect.info')),
    path.join(config, 'maui-sailfish', 'connect.info'),
  ];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) {
      continue;
    }
    const info = parseConnectInfo(fs.readFileSync(file, 'utf8'));
    if (info) {
      return { file, info };
    }
  }
  return undefined;
}
