import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Report } from './deploy';
import * as remote from './remoteScripts';
import { SshConnection } from './ssh';

/** The linux-arm64 vsdbg on this machine; never shipped in the RPM. */
export function localVsdbgDir(): string {
  const configured = vscode.workspace.getConfiguration('mauiSailfish').get<string>('vsdbgPath', '').trim();
  return configured ? configured.replace(/^~(?=$|\/)/, os.homedir()) : path.join(os.homedir(), '.vsdbg-linux-arm64');
}

/** Microsoft's installer for a remote vsdbg, run once in a terminal. */
export async function downloadVsdbg(): Promise<void> {
  const dir = localVsdbgDir();
  const task = new vscode.Task({ type: 'sailfish', step: 'vsdbg' }, vscode.TaskScope.Global, 'download vsdbg (linux-arm64)',
    'MAUI Sailfish', new vscode.ShellExecution(`curl -sSL https://aka.ms/getvsdbgsh | bash -s -- -v latest -r linux-arm64 -l "${dir}"`));
  await vscode.tasks.executeTask(task);
}

/**
 * Puts vsdbg in /tmp/vsdbg (a reboot wipes it) and lets it ptrace a process it did not start; relaxing yama
 * needs root, so the developer-mode password.
 */
export async function ensureDebugger(session: SshConnection, password: string | undefined, report: Report, force = false): Promise<void> {
  const [present, scope] = (await session.exec(remote.debuggerState)).stdout.trim().split(/\s+/);
  if (present !== 'HAVE' || force) {
    const dir = localVsdbgDir();
    if (!fs.existsSync(path.join(dir, 'vsdbg'))) {
      const download = 'Download vsdbg';
      vscode.window.showErrorMessage(`No linux-arm64 vsdbg in ${dir}; download it once, then press F5 again.`, download)
        .then(choice => (choice === download ? downloadVsdbg() : undefined));
      throw new Error(`no vsdbg in ${dir}`);
    }
    await session.uploadTree(dir, remote.VSDBG_DIR, (done, total) => {
      if (done === total || done % 25 === 0) report(`Copying the debugger to the phone (${done}/${total})`);
    });
    await session.exec(`chmod +x ${remote.VSDBG_DIR}/vsdbg`);
  }
  if (scope !== '0' && scope !== 'none') {
    if (!password) {
      throw new Error(`ptrace_scope is ${scope} on the phone; relaxing it needs the developer-mode password (MAUI Sailfish: Set Developer-Mode Password…)`);
    }
    const relaxed = await session.root(remote.relaxPtrace, password);
    if (relaxed.code !== 0) {
      throw new Error(`could not relax ptrace_scope: ${(relaxed.stderr || relaxed.stdout).trim()}`);
    }
  }
}
