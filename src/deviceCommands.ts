import * as vscode from 'vscode';
import { isHost } from './connectInfo';
import { Connector, probe } from './connector';
import { ensureDebugger } from './debuggerSetup';
import * as deploy from './deploy';
import { describe, Device, DeviceStore, findConnectInfo, newDevice } from './devices';
import { Node } from './devicesView';
import { DeviceHealth } from './health';
import { loadKey } from './keys';
import { pickProject, readProperties } from './project';
import { SshError } from './ssh';

/** Device commands of the palette, the status bar picker and the Devices view (which passes its row). */
export class DeviceCommands {
  constructor(
    private readonly store: DeviceStore,
    private readonly connector: Connector,
    private readonly health: DeviceHealth,
    private readonly output: vscode.OutputChannel,
    private readonly context: vscode.ExtensionContext,
  ) {}

  /** Offers the shell tooling's connect.info on first start, then checks the active device quietly. */
  async startup(sailfishWorkspace: boolean): Promise<void> {
    if (sailfishWorkspace && this.store.list().length === 0) {
      const found = findConnectInfo();
      if (found) {
        const use = 'Use It';
        const choice = await vscode.window.showInformationMessage(
          `MAUI Sailfish: use the device ${found.info.user}@${found.info.host} from ${found.file}?`, use, 'Add Another…');
        if (choice === use) {
          const device = newDevice(found.info.host, found.info.user);
          await this.store.save(device, found.info.password ?? '');
          await this.checkConnection({ kind: 'device', device });
          return;
        }
        if (choice === 'Add Another…') {
          await this.addDevice();
          return;
        }
      }
    }
    const current = this.store.current();
    if (current) {
      await this.health.check(current, true).catch(() => undefined);
    }
  }

  async useDevice(node?: Node): Promise<void> {
    const device = node?.kind === 'device' ? node.device : undefined;
    if (!device) return;
    await this.store.select(device.id);
    await this.health.check(device, true).catch(() => undefined);
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.store.list().map(device => this.health.check(device, true).catch(() => undefined)));
  }

  async selectDevice(): Promise<void> {
    const current = this.store.current();
    type Item = vscode.QuickPickItem & { run: () => unknown };
    const items: Item[] = [
      ...this.store.list().map(device => ({
        label: `${device.id === current?.id ? '$(check)' : '$(device-mobile)'} ${device.name}`,
        description: describe(device),
        run: () => this.useDevice({ kind: 'device', device }),
      })),
      { label: '', kind: vscode.QuickPickItemKind.Separator, run: () => undefined },
      { label: '$(add) Add Device…', run: () => this.addDevice() },
      ...(current ? [
        { label: '$(pulse) Check Connection', run: () => this.checkConnection() },
        { label: '$(key) Pair SSH Key', run: () => this.pairKey() },
        { label: '$(lock) Set Developer-Mode Password…', run: () => this.setPassword() },
        { label: '$(debug-alt) Push Debugger to Device', run: () => this.pushDebugger() },
        { label: '$(trash) Forget Device…', run: () => this.forgetDevice() },
      ] : []),
      { label: '$(list-tree) Show Devices View', run: () => vscode.commands.executeCommand('mauiSailfish.devices.focus') },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'MAUI Sailfish device' });
    await picked?.run();
  }

  async addDevice(): Promise<Device | undefined> {
    const suggestion = findConnectInfo()?.info;
    const host = (await vscode.window.showInputBox({
      title: 'Add a Sailfish device (1/3): address',
      prompt: 'The phone\'s IP address, shown in Settings > Developer tools. Over USB networking it is 192.168.2.15.',
      value: suggestion?.host ?? '',
      ignoreFocusOut: true,
      validateInput: value => (isHost(value.trim()) ? undefined : 'An IP address or host name'),
    }))?.trim();
    if (!host) return undefined;
    const user = (await vscode.window.showInputBox({
      title: 'Add a Sailfish device (2/3): user',
      prompt: 'The SSH user; defaultuser on current Sailfish OS.',
      value: suggestion?.user ?? 'defaultuser',
      ignoreFocusOut: true,
    }))?.trim();
    if (!user) return undefined;
    const password = await vscode.window.showInputBox({
      title: 'Add a Sailfish device (3/3): developer-mode password',
      prompt: 'Settings > Developer tools > Remote connection. Kept in the system keychain; pairs an SSH key and runs installs as root.',
      value: suggestion?.host === host ? suggestion.password ?? '' : '',
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return undefined;

    const device = newDevice(host, user);
    try {
      const summary = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Connecting to ${host}` },
        async progress => {
          const session = password ? await this.connector.connectWithPassword(device, password) : await this.connector.connectWithKey(device);
          const info = await probe(session).finally(() => session.close());
          if (!info.sailfish) {
            const add = 'Add Anyway';
            if (await vscode.window.showWarningMessage(`${host} runs ${info.pretty}, not Sailfish OS.`, { modal: true }, add) !== add) {
              throw new vscode.CancellationError();
            }
          }
          await this.store.save(device, password);
          if (password) {
            progress.report({ message: 'Pairing an SSH key' });
            await this.connector.pair(device, password);
          }
          return `${info.pretty}${info.arch ? ` (${info.arch})` : ''}`;
        });
      await this.health.check(device, true).catch(() => undefined);
      vscode.window.showInformationMessage(`MAUI Sailfish: ${describe(device)} runs ${summary}; the SSH key is paired.`);
      return device;
    } catch (err) {
      if (!(err instanceof vscode.CancellationError)) {
        this.fail(err, device);
      }
      return undefined;
    }
  }

  async pairKey(node?: Node): Promise<void> {
    const device = await this.deviceOf(node);
    if (!device) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Pairing an SSH key with ${device.host}` },
        () => this.connector.pair(device));
      await this.health.check(device, true).catch(() => undefined);
      vscode.window.showInformationMessage(`MAUI Sailfish: key login to ${describe(device)} works; no more password prompts for SSH.`);
    } catch (err) {
      this.fail(err, device);
    }
  }

  async checkConnection(node?: Node): Promise<void> {
    const device = await this.deviceOf(node);
    if (!device) return;
    try {
      const health = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Checking ${device.host}` },
        () => this.health.check(device, false));
      if (health && node === undefined) {
        // From the palette or the status bar, where the Devices view may be closed.
        vscode.window.showInformationMessage(`MAUI Sailfish: ${describe(device)} · ${health.os} ${health.arch} · ` +
          `${health.auth === 'key' ? 'SSH key login' : 'password login (Pair SSH Key for debugging)'}`);
      }
    } catch (err) {
      this.fail(err, device);
    }
  }

  async setPassword(node?: Node): Promise<void> {
    const device = await this.deviceOf(node);
    if (!device) return;
    const password = await vscode.window.showInputBox({
      title: `Developer-mode password for ${describe(device)}`,
      prompt: 'Settings > Developer tools > Remote connection. Empty removes the stored password.',
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return;
    await this.store.setPassword(device, password);
    vscode.window.showInformationMessage(password ? 'MAUI Sailfish: password stored in the system keychain.' : 'MAUI Sailfish: password removed.');
  }

  async forgetDevice(node?: Node): Promise<void> {
    const device = await this.deviceOf(node);
    if (!device) return;
    const forget = 'Forget';
    const answer = await vscode.window.showWarningMessage(`Forget ${describe(device)}?`,
      { modal: true, detail: 'Removes it from every workspace, with its stored password and pinned host key. The key authorized on the phone stays there.' }, forget);
    if (answer !== forget) return;
    await this.store.remove(device);
    this.health.forget(device);
  }

  async pushDebugger(node?: Node): Promise<void> {
    const device = await this.deviceOf(node);
    if (!device) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Debugger → ${device.host}` },
        async progress => {
          const session = await this.connector.connect(device);
          try {
            await ensureDebugger(session, await this.store.password(device), message => progress.report({ message }), true);
          } finally {
            session.close();
          }
        });
      await this.health.check(device, true).catch(() => undefined);
      vscode.window.showInformationMessage(`MAUI Sailfish: vsdbg is on ${device.host}.`);
    } catch (err) {
      this.fail(err, device);
    }
  }

  async copyPublicKey(): Promise<void> {
    const key = loadKey();
    if (!key) {
      vscode.window.showWarningMessage('MAUI Sailfish: no SSH key yet; pairing a device creates one.');
      return;
    }
    await vscode.env.clipboard.writeText(key.publicLine);
    vscode.window.showInformationMessage('MAUI Sailfish: public key copied.');
  }

  /** Stops the workspace app on the phone, Debug and Release installs alike. */
  async stopApp(node?: Node): Promise<void> {
    const device = await this.deviceOf(node);
    const project = device && await pickProject(undefined, this.context.workspaceState);
    if (!device || !project) return;
    try {
      const { packageName, assemblyName } = await readProperties(project, 'Release');
      const session = await this.connector.connect(device);
      try {
        await deploy.stop(session, packageName, assemblyName);
        await deploy.stop(session, `${packageName}-debug`, assemblyName);
      } finally {
        session.close();
      }
    } catch (err) {
      this.fail(err, device);
    }
  }

  /** The row's device, else the active one, else a new one. */
  private async deviceOf(node?: Node): Promise<Device | undefined> {
    if (node?.kind === 'device' || (node?.kind === 'detail' && node.device)) {
      return node.device;
    }
    return this.store.current() ?? await this.addDevice();
  }

  private fail(err: unknown, device: Device): void {
    const message = err instanceof Error ? err.message : String(err);
    const actions = err instanceof SshError && err.kind === 'auth' ? ['Pair SSH Key', 'Set Password'] : [];
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${describe(device)}: ${message}`);
    vscode.window.showErrorMessage(`MAUI Sailfish: ${message}`, ...actions).then(choice => {
      if (choice === 'Pair SSH Key') return this.pairKey({ kind: 'device', device });
      if (choice === 'Set Password') return this.setPassword({ kind: 'device', device });
    });
  }
}
