import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectProperties, SAILFISH_TFM, SailfishProject } from './project';

const RPM_ARCH: Record<string, string> = { 'linux-arm64': 'aarch64', 'linux-arm': 'armv7hl' };

export interface BuildRequest {
  project: SailfishProject;
  properties: ProjectProperties;
  configuration: string;
  packageName: string;
  runtimeIdentifier: string;
}

/**
 * dotnet publish with the harbour RPM, as a VS Code task so errors land in Problems. Every build gets a unique
 * release: PackageKit refuses to reinstall an identical version.
 */
export async function publishRpm(request: BuildRequest, token: vscode.CancellationToken): Promise<string> {
  const release = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const args = ['publish', request.project.csproj,
    '-c', request.configuration, '-f', SAILFISH_TFM, '-r', request.runtimeIdentifier,
    '-p:SelfContained=true', '-p:CreateSailfishRpm=true',
    `-p:SailfishRelease=${release}`, `-p:SailfishPackageName=${request.packageName}`,
    '--nologo', '-v', 'minimal'];
  const task = new vscode.Task(
    { type: 'sailfish', step: 'publish' },
    vscode.TaskScope.Workspace,
    `publish ${path.basename(request.project.csproj, '.csproj')} (${request.configuration})`,
    'MAUI Sailfish',
    new vscode.ProcessExecution('dotnet', args, { cwd: request.project.dir, env: { DOTNET_CLI_USE_MSBUILD_SERVER: '0' } }),
    '$msCompile');
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Silent, clear: true, panel: vscode.TaskPanelKind.Dedicated };

  const code = await runTask(task, token);
  if (token.isCancellationRequested) {
    throw new vscode.CancellationError();
  }
  if (code !== 0) {
    throw new Error(`dotnet publish failed (exit ${code}); see the MAUI Sailfish task terminal and Problems`);
  }
  const arch = RPM_ARCH[request.runtimeIdentifier] ?? 'aarch64';
  const suffix = `-${release}.${arch}.rpm`;
  const rpm = fs.existsSync(request.properties.rpmDir)
    ? fs.readdirSync(request.properties.rpmDir).find(f => f.startsWith(`${request.packageName}-`) && f.endsWith(suffix))
    : undefined;
  if (!rpm) {
    throw new Error(`publish succeeded but no ${request.packageName}-*${suffix} in ${request.properties.rpmDir}`);
  }
  return path.join(request.properties.rpmDir, rpm);
}

async function runTask(task: vscode.Task, token: vscode.CancellationToken): Promise<number> {
  const execution = await vscode.tasks.executeTask(task);
  return new Promise(resolve => {
    const cancel = token.onCancellationRequested(() => execution.terminate());
    const done = vscode.tasks.onDidEndTaskProcess(e => {
      if (e.execution === execution) {
        done.dispose();
        cancel.dispose();
        resolve(e.exitCode ?? -1);
      }
    });
  });
}
