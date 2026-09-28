import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { publishRpm } from './build';
import { ConfigurationSwitch } from './buildConfiguration';
import { Connector } from './connector';
import { ensureDebugger } from './debuggerSetup';
import * as deploy from './deploy';
import { describe, DeviceStore } from './devices';
import { loadKey } from './keys';
import { findSailfishProjects, pickProject, readProperties } from './project';
import { VSDBG_DIR } from './remoteScripts';
import { AppRun, RunAdapter, RunRegistry } from './runs';
import { SshError } from './ssh';

const DEFAULT_NAME = 'MAUI Sailfish: Debug on device';

/**
 * F5 on a "sailfish" configuration: build the RPM, install it, start the app and hand over to the C# extension's
 * coreclr attach (vsdbg on the phone, reached through dist/pipe.js). Ctrl+F5 keeps the "sailfish" type and runs
 * through RunAdapter.
 */
export class SailfishDebugProvider implements vscode.DebugConfigurationProvider, vscode.DebugAdapterDescriptorFactory {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: DeviceStore,
    private readonly connector: Connector,
    private readonly runs: RunRegistry,
    private readonly output: vscode.OutputChannel,
    private readonly addDevice: () => Thenable<unknown>,
    private readonly configurationSwitch: ConfigurationSwitch,
  ) {}

  /** "Add Configuration…" into a new launch.json. */
  provideDebugConfigurations(): vscode.DebugConfiguration[] {
    return [{ name: DEFAULT_NAME, type: 'sailfish', request: 'launch' }];
  }

  /**
   * The Run and Debug dropdown without a launch.json: one entry per Sailfish project of the folder. VS Code also
   * asks with no folder (listed as "user settings"); that call gets nothing, or every entry would show twice.
   */
  async provideDynamicConfigurations(folder: vscode.WorkspaceFolder | undefined): Promise<vscode.DebugConfiguration[]> {
    if (!folder) {
      return [];
    }
    // No configuration: the status bar's Debug | Release switch decides.
    return (await findSailfishProjects(folder)).map(file => ({
      name: `MAUI Sailfish: ${path.basename(file, '.csproj')}`,
      type: 'sailfish',
      request: 'launch',
      project: '${workspaceFolder}/' + path.relative(folder.uri.fsPath, file).split(path.sep).join('/'),
    }));
  }

  /** F5 without a launch.json arrives as an empty configuration. */
  resolveDebugConfiguration(_folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration): vscode.DebugConfiguration {
    if (!config.type && !config.request && !config.name) {
      return { name: DEFAULT_NAME, type: 'sailfish', request: 'launch' };
    }
    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(_folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration, token?: vscode.CancellationToken): Promise<vscode.DebugConfiguration | undefined> {
    try {
      return await this.prepare(config, token ?? new vscode.CancellationTokenSource().token);
    } catch (err) {
      if (!(err instanceof vscode.CancellationError)) {
        this.report(err);
      }
      return undefined;   // aborts the launch without opening launch.json
    }
  }

  createDebugAdapterDescriptor(session: vscode.DebugSession): vscode.DebugAdapterDescriptor | undefined {
    const run = this.runs.get(session.configuration.sailfishRun);
    return run ? new vscode.DebugAdapterInlineImplementation(new RunAdapter(run)) : undefined;
  }

  private async prepare(config: vscode.DebugConfiguration, outerToken: vscode.CancellationToken): Promise<vscode.DebugConfiguration> {
    const noDebug = !!config.noDebug;
    if (!this.store.current()) {
      await this.addDevice();
    }
    const device = this.store.current();
    if (!device) {
      throw new vscode.CancellationError();
    }
    const project = await pickProject(config.project, this.context.workspaceState);
    if (!project) {
      throw new Error(config.project
        ? `project ${config.project} does not exist`
        : 'no project in this workspace targets net11.0-sailfish');
    }
    const configuration: string = config.configuration ?? this.configurationSwitch.current;
    const runtimeIdentifier = vscode.workspace.getConfiguration('mauiSailfish').get<string>('runtimeIdentifier', 'linux-arm64');

    const run = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `MAUI Sailfish → ${device.name}`,
      cancellable: true,
    }, async (progress, token) => {
      const cancelled = () => {
        if (token.isCancellationRequested || outerToken.isCancellationRequested) throw new vscode.CancellationError();
      };
      const report = (message: string) => progress.report({ message });

      report('Reading the project');
      const properties = await readProperties(project, configuration);
      // Debug installs next to Release, as its own package.
      const packageName = configuration === 'Debug' ? `${properties.packageName}-debug` : properties.packageName;

      report(`Connecting to ${describe(device)}`);
      let session = await this.connector.connect(device);
      try {
        const password = await this.store.password(device);
        if (!noDebug && session.auth === 'password') {
          // The debugger pipe cannot type a password: pair once, now, with the one that just worked.
          report('Pairing an SSH key for the debugger');
          await this.connector.pair(device, password);
        }
        cancelled();

        report('Building');
        const rpm = await publishRpm({ project, properties, configuration, packageName, runtimeIdentifier }, token);
        cancelled();

        // The session sat idle through the build; a fresh one avoids a dropped Wi-Fi link.
        session.close();
        session = await this.connector.connect(device);
        report('Stopping the running app');
        this.runs.forget(packageName);
        await deploy.stop(session, packageName, properties.assemblyName);
        await deploy.install(session, rpm, password, report, this.output);
        cancelled();

        if (!noDebug) {
          report('Preparing the debugger');
          await ensureDebugger(session, password, report);
        }
        report('Starting the app');
        const pid = await deploy.launch(session, packageName, stringEnv(config.env), !noDebug);
        const started = new AppRun(this.connector, device, packageName, pid);
        this.runs.add(started);
        await started.startLog();
        return started;
      } finally {
        session.close();
      }
    });

    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${run.packageName} started on ${device.host} (pid ${run.pid})`);
    run.onOutput(text => this.output.append(text));

    if (noDebug) {
      return { ...config, type: 'sailfish', request: 'launch', name: config.name ?? DEFAULT_NAME, sailfishRun: run.id };
    }
    return this.attachConfiguration(config, run, project.dir, configuration);
  }

  /** The C# extension's remote attach; vsdbg's license handshake only accepts VS Code with that extension. */
  private attachConfiguration(config: vscode.DebugConfiguration, run: AppRun, cwd: string, configuration: string): vscode.DebugConfiguration {
    const device = run.device;
    const key = loadKey();
    const agent = process.env.SSH_AUTH_SOCK && fs.existsSync(process.env.SSH_AUTH_SOCK) ? process.env.SSH_AUTH_SOCK : undefined;
    return {
      name: config.name ?? DEFAULT_NAME,
      type: 'coreclr',
      request: 'attach',
      processId: String(run.pid),
      // Release is trimmed and ReadyToRun: vsdbg counts optimized code as not the user's, so Just My Code would
      // leave its breakpoints unbound.
      justMyCode: config.justMyCode ?? configuration !== 'Release',
      pipeTransport: {
        pipeCwd: cwd,
        pipeProgram: process.execPath,
        pipeArgs: [this.context.asAbsolutePath('dist/pipe.js')],
        pipeEnv: {
          ELECTRON_RUN_AS_NODE: '1',
          MAUI_SAILFISH_PIPE: JSON.stringify({
            host: device.host, port: device.port, user: device.user,
            privateKeyPath: key?.privatePath, agent, fingerprint: this.store.pinnedHostKey(device),
          }),
        },
        debuggerPath: `${VSDBG_DIR}/vsdbg`,
        quoteArgs: true,
      },
      sailfishRun: run.id,
    };
  }

  private report(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const actions: string[] = [];
    if (err instanceof SshError) {
      if (err.kind === 'auth') actions.push('Pair SSH Key', 'Set Password');
      if (err.kind === 'unreachable' || err.kind === 'hostkey') actions.push('Select Device');
    }
    actions.push('Show Log');
    vscode.window.showErrorMessage(`MAUI Sailfish: ${message}`, ...actions).then(choice => {
      switch (choice) {
        case 'Pair SSH Key': return vscode.commands.executeCommand('mauiSailfish.pairKey');
        case 'Set Password': return vscode.commands.executeCommand('mauiSailfish.setPassword');
        case 'Select Device': return vscode.commands.executeCommand('mauiSailfish.selectDevice');
        case 'Show Log': return this.output.show();
      }
    });
  }
}

function stringEnv(env: unknown): Record<string, string> {
  if (!env || typeof env !== 'object') {
    return {};
  }
  return Object.fromEntries(Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}
