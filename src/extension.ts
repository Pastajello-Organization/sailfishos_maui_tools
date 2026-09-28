import * as vscode from 'vscode';
import { ConfigurationSwitch } from './buildConfiguration';
import { Connector } from './connector';
import { DeviceCommands } from './deviceCommands';
import { DeviceStore } from './devices';
import { DevicesView, Node } from './devicesView';
import { SailfishDebugProvider } from './debugProvider';
import { DeviceHealth } from './health';
import { RunRegistry } from './runs';
import { DeviceStatusBar } from './statusBar';

export function activate(context: vscode.ExtensionContext): void {
  const store = new DeviceStore(context.globalState, context.workspaceState, context.secrets);
  const connector = new Connector(store);
  const health = new DeviceHealth(store, connector);
  const runs = new RunRegistry();
  const output = vscode.window.createOutputChannel('MAUI Sailfish');
  const status = new DeviceStatusBar(store, health);
  const configurationSwitch = new ConfigurationSwitch(context.workspaceState);
  const view = new DevicesView(store, health);
  const commands = new DeviceCommands(store, connector, health, output, context);
  const provider = new SailfishDebugProvider(context, store, connector, runs, output, () => commands.addDevice(), configurationSwitch);
  const command = (id: string, run: (node?: Node) => unknown) => vscode.commands.registerCommand(id, run);

  context.subscriptions.push(
    output,
    status,
    configurationSwitch,
    view,
    vscode.window.registerTreeDataProvider('mauiSailfish.devices', view),
    vscode.debug.registerDebugConfigurationProvider('sailfish', provider),
    // The Run and Debug dropdown; a separate object, since every registration gets the resolve calls (a double build).
    vscode.debug.registerDebugConfigurationProvider('sailfish',
      { provideDebugConfigurations: folder => provider.provideDynamicConfigurations(folder) },
      vscode.DebugConfigurationProviderTriggerKind.Dynamic),
    vscode.debug.registerDebugAdapterDescriptorFactory('sailfish', provider),
    // An attached vsdbg never sees the app's stdout: the log stream feeds the Debug Console instead.
    vscode.debug.onDidStartDebugSession(session => {
      const run = session.type === 'coreclr' ? runs.get(session.configuration.sailfishRun) : undefined;
      if (run) {
        const forward = run.onOutput(text => {
          if (vscode.debug.activeDebugSession?.id === session.id) vscode.debug.activeDebugConsole.append(text);
        });
        run.onExit(() => forward.dispose());
      }
    }),
    // Stopping the debugger stops the app, as MAUI does on Android and iOS.
    vscode.debug.onDidTerminateDebugSession(session => runs.get(session.configuration.sailfishRun)?.stop().catch(() => undefined)),
    command('mauiSailfish.selectDevice', () => commands.selectDevice()),
    command('mauiSailfish.selectConfiguration', () => configurationSwitch.select()),
    command('mauiSailfish.useDevice', node => commands.useDevice(node)),
    command('mauiSailfish.addDevice', () => commands.addDevice()),
    command('mauiSailfish.refreshDevices', () => commands.refreshAll()),
    command('mauiSailfish.pairKey', node => commands.pairKey(node)),
    command('mauiSailfish.checkConnection', node => commands.checkConnection(node)),
    command('mauiSailfish.setPassword', node => commands.setPassword(node)),
    command('mauiSailfish.forgetDevice', node => commands.forgetDevice(node)),
    command('mauiSailfish.pushDebugger', node => commands.pushDebugger(node)),
    command('mauiSailfish.stopApp', node => commands.stopApp(node)),
    command('mauiSailfish.copyPublicKey', () => commands.copyPublicKey()),
  );

  void startup(store, [status, configurationSwitch], commands);
}

export function deactivate(): void {}

/** The status bar shows in Sailfish workspaces (or once a device exists); the Devices view is always there. */
async function startup(store: DeviceStore, statusItems: { show(): void }[], commands: DeviceCommands): Promise<void> {
  const projects = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj,node_modules}/**');
  const sailfish = (await Promise.all(projects.map(async uri =>
    Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').includes('net11.0-sailfish')))).some(Boolean);
  if (sailfish || store.list().length > 0) {
    statusItems.forEach(item => item.show());
  }
  await commands.startup(sailfish);
}
