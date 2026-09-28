import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Client, ClientChannel, ConnectConfig, SFTPWrapper } from 'ssh2';

export interface SshTarget {
  host: string;
  port: number;
  user: string;
}

export interface SshCredentials {
  privateKey?: Buffer;
  password?: string;
  agent?: string;
}

/** Decides on a host key the first time (or rejects a changed one): gets the OpenSSH-style fingerprint. */
export type HostKeyCheck = (fingerprint: string) => Promise<boolean>;

export type SshFailure = 'unreachable' | 'auth' | 'hostkey' | 'other';

export class SshError extends Error {
  constructor(message: string, readonly kind: SshFailure) {
    super(message);
  }
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  stdin?: string | Buffer;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

/** "SHA256:<base64>" as ssh-keygen -l prints it. */
export function fingerprintOf(hostKey: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/, '');
}

/** One authenticated ssh2 session to the phone. */
export class SshConnection {
  private constructor(
    private readonly client: Client,
    readonly target: SshTarget,
    readonly hostFingerprint: string,
    /** 'key' for a key or agent login, 'password' for the developer-mode password. */
    readonly auth: 'key' | 'password',
  ) {}

  static open(target: SshTarget, credentials: SshCredentials, checkHostKey: HostKeyCheck,
              timeoutMs = 10000): Promise<SshConnection> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let fingerprint = '';
      let hostKeyRejected = false;
      const methods: string[] = [];
      if (credentials.privateKey) methods.push('publickey');
      if (credentials.agent) methods.push('agent');
      if (credentials.password) methods.push('password', 'keyboard-interactive');
      const config: ConnectConfig = {
        host: target.host,
        port: target.port,
        username: target.user,
        privateKey: credentials.privateKey,
        agent: credentials.agent,
        password: credentials.password,
        tryKeyboard: !!credentials.password,
        readyTimeout: timeoutMs,
        keepaliveInterval: 15000,
        authHandler: methods as any,
        hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
          fingerprint = fingerprintOf(key);
          checkHostKey(fingerprint).then(ok => {
            hostKeyRejected = !ok;
            verify(ok);
          }, () => {
            hostKeyRejected = true;
            verify(false);
          });
        },
      };
      // Sailfish's sshd may ask for the password as keyboard-interactive.
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) =>
        finish(prompts.map(() => credentials.password ?? '')));
      // Callers pass either key material or a password, never both, so the method that worked is known.
      client.on('ready', () =>
        resolve(new SshConnection(client, target, fingerprint, credentials.password ? 'password' : 'key')));
      client.on('error', (err: Error & { level?: string; code?: string }) => {
        client.end();
        if (hostKeyRejected) {
          reject(new SshError(`host key of ${target.host} was not accepted (${fingerprint})`, 'hostkey'));
        } else if (err.level === 'client-authentication') {
          reject(new SshError(`${target.user}@${target.host} rejected the login`, 'auth'));
        } else if (err.level === 'client-timeout' || ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTDOWN']
          .includes(err.code ?? '')) {
          reject(new SshError(`cannot reach ${target.host}:${target.port} (${err.code ?? err.message})`, 'unreachable'));
        } else {
          reject(new SshError(err.message, 'other'));
        }
      });
      client.connect(config);
    });
  }

  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(command, (err, channel) => {
        if (err) {
          reject(err);
          return;
        }
        let stdout = '';
        let stderr = '';
        channel.on('data', (data: Buffer) => {
          const text = data.toString('utf8');
          stdout += text;
          options.onStdout?.(text);
        });
        channel.stderr.on('data', (data: Buffer) => {
          const text = data.toString('utf8');
          stderr += text;
          options.onStderr?.(text);
        });
        channel.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }));
        channel.end(options.stdin ?? '');
      });
    });
  }

  /** A raw channel for a long-lived stream (the debugger's DAP connection). */
  channel(command: string): Promise<ClientChannel> {
    return new Promise((resolve, reject) =>
      this.client.exec(command, (err, channel) => (err ? reject(err) : resolve(channel))));
  }

  /** Runs a shell script from stdin (see remoteScripts.ts). */
  script(script: string, options: Omit<ExecOptions, 'stdin'> = {}): Promise<ExecResult> {
    return this.exec('sh -s', { ...options, stdin: script });
  }

  /** Runs a script as root through devel-su, which reads the developer-mode password from stdin. */
  root(script: string, password: string, options: Omit<ExecOptions, 'stdin'> = {}): Promise<ExecResult> {
    const b64 = Buffer.from(script, 'utf8').toString('base64');
    return this.exec(`devel-su /bin/sh -c 'echo ${b64} | base64 -d | /bin/sh -s'`, { ...options, stdin: password + '\n' });
  }

  private sftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => this.client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp))));
  }

  async upload(localPath: string, remotePath: string, onProgress?: (done: number, total: number) => void): Promise<void> {
    const sftp = await this.sftp();
    try {
      await new Promise<void>((resolve, reject) =>
        sftp.fastPut(localPath, remotePath, { step: (done, _chunk, total) => onProgress?.(done, total) },
          err => (err ? reject(err) : resolve())));
    } finally {
      sftp.end();
    }
  }

  /** Copies a directory tree (vsdbg: a few hundred files) with a few transfers in flight. */
  async uploadTree(localDir: string, remoteDir: string, onFile?: (done: number, total: number) => void): Promise<void> {
    const files: string[] = [];
    const dirs: string[] = [''];
    const walk = (rel: string) => {
      for (const entry of fs.readdirSync(path.join(localDir, rel), { withFileTypes: true })) {
        const child = path.posix.join(rel, entry.name);
        if (entry.isDirectory()) {
          dirs.push(child);
          walk(child);
        } else if (entry.isFile()) {
          files.push(child);
        }
      }
    };
    walk('');
    const mkdirs = dirs.map(d => `'${path.posix.join(remoteDir, d).replace(/'/g, `'\\''`)}'`).join(' ');
    const made = await this.exec(`mkdir -p ${mkdirs}`);
    if (made.code !== 0) {
      throw new Error(`cannot create ${remoteDir}: ${made.stderr.trim()}`);
    }
    const sftp = await this.sftp();
    try {
      let next = 0;
      let done = 0;
      const worker = async () => {
        while (next < files.length) {
          const rel = files[next++];
          await new Promise<void>((resolve, reject) =>
            sftp.fastPut(path.join(localDir, rel), path.posix.join(remoteDir, rel), err => (err ? reject(err) : resolve())));
          onFile?.(++done, files.length);
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
    } finally {
      sftp.end();
    }
  }

  close(): void {
    this.client.end();
  }
}
