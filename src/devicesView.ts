import * as fs from 'fs';
import * as vscode from 'vscode';
import { describe, Device, DeviceStore } from './devices';
import { DeviceHealth, Health } from './health';
import { keyPath, loadKey, publicFingerprint } from './keys';

/** A row of the Devices view; commands invoked from its menus receive it as their argument. */
export type Node =
  | { kind: 'device'; device: Device }
  | { kind: 'detail'; device?: Device; id: string; label: string; description?: string; icon: string; color?: string; tooltip?: string }
  | { kind: 'key' };

/** The activity bar's Devices view: every known phone (for all workspaces), its state, and the SSH key in use. */
export class DevicesView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly store: DeviceStore, private readonly health: DeviceHealth) {
    this.subscriptions = [
      store.onDidChange(() => this.refresh()),
      health.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('mauiSailfish.sshKeyPath') && this.refresh()),
    ];
  }

  refresh(): void {
    this.changed.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    switch (node.kind) {
      case 'device':
        return this.deviceItem(node.device);
      case 'key': {
        const key = loadKey();
        const item = new vscode.TreeItem('SSH key', vscode.TreeItemCollapsibleState.Collapsed);
        item.id = 'ssh-key';
        item.iconPath = new vscode.ThemeIcon('key');
        item.description = key ? tildify(key.privatePath) : 'created when a device is paired';
        item.contextValue = key ? 'sshKey' : 'sshKey.missing';
        return item;
      }
      case 'detail': {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.id = node.id;
        item.description = node.description;
        item.tooltip = node.tooltip ?? (node.description ? `${node.label}: ${node.description}` : node.label);
        item.iconPath = new vscode.ThemeIcon(node.icon, node.color ? new vscode.ThemeColor(node.color) : undefined);
        return item;
      }
    }
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      const devices = this.store.list().sort((a, b) => a.name.localeCompare(b.name));
      // Empty: the view's welcome content (Add Device) shows instead.
      return devices.length ? [...devices.map(device => ({ kind: 'device' as const, device })), { kind: 'key' }] : [];
    }
    if (node.kind === 'device') {
      return this.deviceDetails(node.device);
    }
    if (node.kind === 'key') {
      return keyDetails();
    }
    return [];
  }

  private deviceItem(device: Device): vscode.TreeItem {
    const active = this.store.current()?.id === device.id;
    const health = this.health.get(device);
    const item = new vscode.TreeItem(device.name,
      active ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `device:${device.id}`;
    item.description = [device.name !== device.host ? device.host : device.user, active ? 'active' : ''].filter(Boolean).join(' · ');
    item.iconPath = health?.state === 'checking' ? new vscode.ThemeIcon('sync~spin')
      : health?.state === 'error' ? new vscode.ThemeIcon('device-mobile', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : health?.state === 'ok' ? new vscode.ThemeIcon('device-mobile', new vscode.ThemeColor('testing.iconPassed'))
      : new vscode.ThemeIcon('device-mobile');
    item.contextValue = active ? 'device.active' : 'device';
    item.tooltip = new vscode.MarkdownString(`**${describe(device)}**${active ? ' (active in this workspace)' : ''}\n\n${summary(health)}`);
    if (!active) {
      item.command = { command: 'mauiSailfish.useDevice', title: 'Use This Device', arguments: [{ kind: 'device', device }] };
    }
    return item;
  }

  private async deviceDetails(device: Device): Promise<Node[]> {
    const health = this.health.get(device);
    const password = await this.store.password(device);
    const pinned = this.store.pinnedHostKey(device);
    const id = (name: string) => `${device.id}/${name}`;
    const rows: Node[] = [];

    if (health?.state === 'error') {
      rows.push({ kind: 'detail', device, id: id('error'), label: 'Not reachable', description: health.error, icon: 'error', color: 'problemsErrorIcon.foreground' });
    }
    rows.push(health?.os
      ? { kind: 'detail', device, id: id('os'), label: health.os, description: health.arch,
          icon: health.sailfish ? 'check' : 'warning', color: health.sailfish ? undefined : 'problemsWarningIcon.foreground' }
      : { kind: 'detail', device, id: id('os'), label: 'Not checked yet', description: 'refresh to connect', icon: 'circle-outline' });
    rows.push(health?.auth === 'key'
      ? { kind: 'detail', device, id: id('auth'), label: 'SSH key login', icon: 'key' }
      : health?.auth === 'password'
        ? { kind: 'detail', device, id: id('auth'), label: 'Password login only', description: 'pair a key to debug', icon: 'key', color: 'problemsWarningIcon.foreground' }
        : { kind: 'detail', device, id: id('auth'), label: 'Login', description: 'unknown until checked', icon: 'key' });
    rows.push({ kind: 'detail', device, id: id('password'), icon: 'lock',
      label: password ? 'Password in the keychain' : 'No password stored',
      description: password ? 'installs as root' : 'installs via PackageKit' });
    rows.push({ kind: 'detail', device, id: id('hostkey'), icon: 'shield',
      label: pinned ? 'Host key pinned' : 'Host key not pinned yet', description: pinned, tooltip: pinned });
    if (health?.state === 'ok') {
      const ptraceOk = health.ptrace === '0' || health.ptrace === 'none';
      rows.push({ kind: 'detail', device, id: id('debugger'), icon: 'debug-alt',
        label: health.debugger ? 'vsdbg on the phone' : 'vsdbg not on the phone',
        description: [health.debugger ? '' : 'F5 copies it', ptraceOk ? '' : `ptrace_scope ${health.ptrace}`].filter(Boolean).join(' · ') || undefined });
      rows.push({ kind: 'detail', device, id: id('checked'), icon: 'history', label: 'Checked', description: health.checkedAt?.toLocaleTimeString() });
    }
    return rows;
  }

  dispose(): void {
    this.subscriptions.forEach(s => s.dispose());
    this.changed.dispose();
  }
}

function keyDetails(): Node[] {
  const key = loadKey();
  if (!key) {
    const file = keyPath();
    return [{ kind: 'detail', id: 'key/none', icon: 'info', label: fs.existsSync(file) ? 'Needs a passphrase' : 'No key yet',
      description: fs.existsSync(file) ? 'use ssh-agent or another key' : `pairing creates ${tildify(file)}` }];
  }
  const [type, , comment] = key.publicLine.split(/\s+/);
  return [
    { kind: 'detail', id: 'key/fingerprint', icon: 'symbol-key', label: publicFingerprint(key.publicLine), description: type },
    ...(comment ? [{ kind: 'detail' as const, id: 'key/comment', icon: 'tag', label: comment }] : []),
  ];
}

function summary(health: Health | undefined): string {
  if (!health) return 'Not checked yet.';
  if (health.state === 'checking') return 'Checking…';
  if (health.state === 'error') return `Not reachable: ${health.error}`;
  return `${health.os ?? ''} ${health.arch ?? ''} · ${health.auth === 'key' ? 'SSH key login' : 'password login'}`;
}

function tildify(file: string): string {
  const home = process.env.HOME ?? '';
  return home && file.startsWith(home) ? `~${file.slice(home.length)}` : file;
}
