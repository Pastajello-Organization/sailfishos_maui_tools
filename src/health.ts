import * as vscode from 'vscode';
import { Connector, probe } from './connector';
import { Device, DeviceStore } from './devices';
import * as remote from './remoteScripts';
import { SshError, SshFailure } from './ssh';

/** What the last check found out about a phone; the status bar and the Devices view both show it. */
export interface Health {
  state: 'checking' | 'ok' | 'error';
  checkedAt?: Date;
  os?: string;
  arch?: string;
  sailfish?: boolean;
  auth?: 'key' | 'password';
  debugger?: boolean;
  ptrace?: string;
  error?: string;
  errorKind?: SshFailure;
}

export class DeviceHealth {
  private readonly health = new Map<string, Health>();
  private readonly changed = new vscode.EventEmitter<string>();
  /** Fires with the device id. */
  readonly onDidChange = this.changed.event;

  constructor(private readonly store: DeviceStore, private readonly connector: Connector) {}

  get(device: Device): Health | undefined {
    return this.health.get(device.id);
  }

  set(device: Device, health: Health): void {
    this.health.set(device.id, health);
    this.changed.fire(device.id);
  }

  forget(device: Device): void {
    this.health.delete(device.id);
    this.changed.fire(device.id);
  }

  /**
   * Connects and reads the OS, the login method and the debugger state. Quiet checks never prompt: no password
   * question, and a device whose host key is not pinned yet is left unchecked.
   */
  async check(device: Device, quiet: boolean): Promise<Health | undefined> {
    if (quiet && !this.store.pinnedHostKey(device)) {
      return undefined;
    }
    const previous = this.get(device);
    this.set(device, { ...previous, state: 'checking' });
    try {
      const session = await this.connector.connect(device, !quiet);
      try {
        const info = await probe(session);
        const [debuggerState, ptrace] = (await session.exec(remote.debuggerState)).stdout.trim().split(/\s+/);
        const health: Health = {
          state: 'ok', checkedAt: new Date(), os: info.pretty, arch: info.arch, sailfish: info.sailfish,
          auth: session.auth, debugger: debuggerState === 'HAVE', ptrace,
        };
        this.set(device, health);
        return health;
      } finally {
        session.close();
      }
    } catch (err) {
      this.set(device, {
        ...previous, state: 'error', checkedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
        errorKind: err instanceof SshError ? err.kind : 'other',
      });
      throw err;
    }
  }
}
