import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as remote from './remoteScripts';
import { SshConnection } from './ssh';

export type Report = (message: string) => void;

/** Uploads the RPM, checks it arrived intact and installs it: as root with the password, else via PackageKit. */
export async function install(session: SshConnection, rpm: string, password: string | undefined, report: Report,
                              output: vscode.OutputChannel): Promise<void> {
  const remoteRpm = `/home/${session.target.user}/${path.basename(rpm)}`;
  const size = fs.statSync(rpm).size;
  let shown = -1;
  await session.upload(rpm, remoteRpm, done => {
    const percent = Math.floor((done / size) * 100);
    if (percent >= shown + 10) {
      shown = percent;
      report(`Uploading ${path.basename(rpm)} (${percent}%)`);
    }
  });
  const local = crypto.createHash('sha256').update(fs.readFileSync(rpm)).digest('hex');
  const uploaded = (await session.exec(`sha256sum ${remote.shq(remoteRpm)}`)).stdout.split(/\s/)[0];
  if (uploaded !== local) {
    throw new Error(`the uploaded RPM is corrupt (device ${uploaded || 'missing'}, local ${local})`);
  }
  report('Installing');
  const log = (text: string) => output.append(text);
  const result = password
    ? await session.root(remote.installAsRoot(remoteRpm), password, { onStdout: log, onStderr: log })
    : await session.script(remote.installWithPackageKit(remoteRpm), { onStdout: log, onStderr: log });
  if (result.code !== 0) {
    const reason = /incorrect password|authentication failure/i.test(result.stderr + result.stdout)
      ? 'devel-su rejected the developer-mode password (MAUI Sailfish: Set Developer-Mode Password…)'
      : `exit ${result.code}; see the MAUI Sailfish output`;
    throw new Error(`install failed: ${reason}`);
  }
}

export async function stop(session: SshConnection, packageName: string, assemblyName = ''): Promise<void> {
  await session.script(remote.stopApp(packageName, assemblyName));
}

/** Starts the installed app and returns its pid; the launcher is the process vsdbg attaches to. */
export async function launch(session: SshConnection, packageName: string, env: Record<string, string>,
                             diagnostics: boolean): Promise<number> {
  const result = await session.script(remote.launchApp(packageName, env, diagnostics));
  const pid = /PID=(\d+)/.exec(result.stdout);
  if (!pid) {
    throw new Error(`the app did not start:\n${(result.stdout + result.stderr).replace(/^LAUNCH-FAILED /m, '').trim()}`);
  }
  return Number(pid[1]);
}

/** Streams the app's stdout/stderr until it exits; runs on its own session so it outlives the deploy. */
export function followLog(session: SshConnection, packageName: string, pid: number, sink: (text: string) => void): Promise<void> {
  return session.script(remote.followLog(packageName, pid), { onStdout: sink, onStderr: sink }).then(() => undefined);
}
