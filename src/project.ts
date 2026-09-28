import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export const SAILFISH_TFM = 'net11.0-sailfish';
const LAST_PROJECT = 'mauiSailfish.lastProject';

export interface SailfishProject {
  csproj: string;
  dir: string;
}

export interface ProjectProperties {
  packageName: string;
  assemblyName: string;
  rpmDir: string;
}

/** The .csproj files targeting net11.0-sailfish, in one workspace folder or the whole workspace. */
export async function findSailfishProjects(folder?: vscode.WorkspaceFolder): Promise<string[]> {
  const include = folder ? new vscode.RelativePattern(folder, '**/*.csproj') : '**/*.csproj';
  return (await vscode.workspace.findFiles(include, '**/{bin,obj,node_modules}/**'))
    .map(uri => uri.fsPath)
    .filter(file => fs.readFileSync(file, 'utf8').includes(SAILFISH_TFM))
    .sort();
}

/** The launch config's project, else the workspace's Sailfish head (asking when there are several). */
export async function pickProject(explicit: string | undefined, state: vscode.Memento): Promise<SailfishProject | undefined> {
  if (explicit) {
    return fs.existsSync(explicit) ? toProject(explicit) : undefined;
  }
  const found = await findSailfishProjects();
  if (found.length <= 1) {
    return found[0] ? toProject(found[0]) : undefined;
  }
  const last = state.get<string>(LAST_PROJECT);
  const items = found.map(file => ({
    label: path.basename(file, '.csproj'),
    description: vscode.workspace.asRelativePath(file),
    file,
  }));
  items.sort((a, b) => (a.file === last ? -1 : b.file === last ? 1 : 0));
  const picked = await vscode.window.showQuickPick(items, { title: 'Which app goes to the phone?' });
  if (!picked) {
    return undefined;
  }
  await state.update(LAST_PROJECT, picked.file);
  return toProject(picked.file);
}

function toProject(csproj: string): SailfishProject {
  return { csproj, dir: path.dirname(csproj) };
}

/** Asks MSBuild rather than guessing names: the package (harbour-…), the binary and where the RPM lands. */
export function readProperties(project: SailfishProject, configuration: string): Promise<ProjectProperties> {
  const args = ['msbuild', project.csproj, '-nologo',
    '-getProperty:SailfishPackageName', '-getProperty:AssemblyName', '-getProperty:SailfishRpmOutputDir',
    `-p:TargetFramework=${SAILFISH_TFM}`, `-p:Configuration=${configuration}`];
  return new Promise((resolve, reject) => {
    execFile('dotnet', args, { cwd: project.dir, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`dotnet msbuild could not evaluate ${path.basename(project.csproj)}: ${(stderr || stdout || err.message).trim()}`));
        return;
      }
      try {
        const props = JSON.parse(stdout).Properties as Record<string, string>;
        const assemblyName = props.AssemblyName || path.basename(project.csproj, '.csproj');
        resolve({
          packageName: props.SailfishPackageName || `harbour-${assemblyName.toLowerCase()}`,
          assemblyName,
          rpmDir: props.SailfishRpmOutputDir || path.join(project.dir, 'bin', 'SailfishRpm'),
        });
      } catch {
        reject(new Error(`unexpected dotnet msbuild output: ${stdout.slice(0, 300)}`));
      }
    });
  });
}
