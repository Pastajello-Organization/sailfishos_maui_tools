import * as vscode from 'vscode';
import { describe, DeviceStore } from './devices';
import { DeviceHealth } from './health';

/** The active device in the status bar, like the MAUI extension's target selector; a click opens the picker. */
export class DeviceStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('mauiSailfish.device', vscode.StatusBarAlignment.Left, 50);
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly store: DeviceStore, private readonly health: DeviceHealth) {
    this.item.name = 'MAUI Sailfish Device';
    this.item.command = 'mauiSailfish.selectDevice';
    this.subscriptions = [store.onDidChange(() => this.render()), health.onDidChange(() => this.render())];
    this.render();
  }

  show(): void {
    this.item.show();
  }

  private render(): void {
    const device = this.store.current();
    if (!device) {
      this.item.text = '$(device-mobile) No Sailfish device';
      this.item.tooltip = 'Add the phone to deploy and debug on it';
      this.item.backgroundColor = undefined;
      return;
    }
    const health = this.health.get(device);
    const icon = health?.state === 'checking' ? '$(sync~spin)' : health?.state === 'error' ? '$(warning)' : '$(device-mobile)';
    this.item.text = `${icon} ${device.name}`;
    const line = !health ? 'Not checked yet'
      : health.state === 'checking' ? 'Checking the connection…'
      : health.state === 'error' ? health.error
      : `${health.os} · ${health.auth === 'key' ? 'SSH key login' : 'password login'}`;
    this.item.tooltip = new vscode.MarkdownString(`**Sailfish device** ${describe(device)}\n\n${line}`);
    this.item.backgroundColor = health?.state === 'error' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  dispose(): void {
    this.subscriptions.forEach(s => s.dispose());
    this.item.dispose();
  }
}
