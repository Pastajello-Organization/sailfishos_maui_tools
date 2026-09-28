import * as vscode from 'vscode';
import { Connector } from './connector';
import * as deploy from './deploy';
import { Device } from './devices';
import { SshConnection } from './ssh';

/** An app started on the phone by F5 / Ctrl+F5: its log stream, and stopping it when the session ends. */
export class AppRun {
  private static nextId = 1;
  readonly id = `run-${AppRun.nextId++}`;
  private readonly output = new vscode.EventEmitter<string>();
  private readonly exited = new vscode.EventEmitter<void>();
  private readonly backlog: string[] = [];
  private logSession?: SshConnection;
  private stopped = false;
  hasExited = false;

  /** Log text; a new listener first gets what arrived before it (the output channel and the console join at different times). */
  onOutput(listener: (text: string) => void): vscode.Disposable {
    this.backlog.forEach(listener);
    return this.output.event(listener);
  }

  readonly onExit = this.exited.event;

  constructor(private readonly connector: Connector, readonly device: Device, readonly packageName: string, readonly pid: number) {}

  /** Streams the app's stdout/stderr over its own session until the process exits. */
  async startLog(): Promise<void> {
    this.logSession = await this.connector.connect(this.device, false);
    const sink = (text: string) => {
      if (this.backlog.length < 5000) this.backlog.push(text);
      this.output.fire(text);
    };
    deploy.followLog(this.logSession, this.packageName, this.pid, sink)
      .catch(err => sink(`[log stream ended: ${err instanceof Error ? err.message : err}]\n`))
      .finally(() => {
        this.hasExited = true;
        this.logSession?.close();
        this.exited.fire();
      });
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (!this.hasExited) {
      const session = await this.connector.connect(this.device, false);
      try {
        await deploy.stop(session, this.packageName);
      } finally {
        session.close();
      }
    }
    this.logSession?.close();
  }
}

export class RunRegistry {
  private readonly runs = new Map<string, AppRun>();

  add(run: AppRun): void {
    this.runs.set(run.id, run);
    run.onExit(() => setTimeout(() => this.runs.delete(run.id), 60000));
  }

  get(id: unknown): AppRun | undefined {
    return typeof id === 'string' ? this.runs.get(id) : undefined;
  }

  /** Earlier runs of the same package are gone once a new build replaces them. */
  forget(packageName: string): void {
    for (const [id, run] of this.runs) {
      if (run.packageName === packageName) this.runs.delete(id);
    }
  }
}

/**
 * Ctrl+F5: a tiny in-process debug adapter, so a run without the debugger still gets VS Code's stop button and
 * the app log in the Debug Console.
 */
export class RunAdapter implements vscode.DebugAdapter {
  private readonly messages = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.messages.event;
  private seq = 1;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly run: AppRun) {}

  handleMessage(message: any): void {
    if (message.type !== 'request') {
      return;
    }
    switch (message.command) {
      case 'initialize':
        this.respond(message, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
        this.event('initialized');
        break;
      case 'launch':
        this.respond(message);
        this.event('output', { category: 'console', output: `${this.run.packageName} runs on ${this.run.device.host} (pid ${this.run.pid})\n` });
        this.subscriptions.push(
          this.run.onOutput(text => this.event('output', { category: 'stdout', output: text })),
          this.run.onExit(() => this.event('terminated')));
        if (this.run.hasExited) this.event('terminated');
        break;
      case 'threads':
        this.respond(message, { threads: [] });
        break;
      case 'terminate':
      case 'disconnect':
        this.run.stop().catch(() => undefined).finally(() => {
          this.respond(message);
          if (message.command === 'terminate') this.event('terminated');
        });
        break;
      default:
        this.respond(message);
    }
  }

  private respond(request: any, body: object = {}): void {
    this.messages.fire({ type: 'response', seq: this.seq++, request_seq: request.seq, command: request.command, success: true, body } as any);
  }

  private event(event: string, body: object = {}): void {
    this.messages.fire({ type: 'event', seq: this.seq++, event, body } as any);
  }

  dispose(): void {
    this.subscriptions.forEach(s => s.dispose());
  }
}
