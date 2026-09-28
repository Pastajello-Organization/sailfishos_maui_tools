// pipeTransport program of the coreclr attach: VS Code speaks DAP on stdin/stdout, this runs vsdbg on the phone
// over ssh and drops the breakpoint checksums vsdbg rejects on the way in. Only DAP may reach stdout.
import * as fs from 'fs';
import { DapFilter } from './dapFilter';
import { SshConnection } from './ssh';

interface PipeConfig {
  host: string;
  port: number;
  user: string;
  privateKeyPath?: string;
  agent?: string;
  fingerprint: string;
}

async function main(): Promise<number> {
  const config = JSON.parse(process.env.MAUI_SAILFISH_PIPE ?? '{}') as PipeConfig;
  // VS Code appends "<debuggerPath> --interpreter=vscode" after our own script path.
  const command = process.argv.slice(2).join(' ');
  if (!config.host || !command) {
    process.stderr.write('maui-sailfish pipe: MAUI_SAILFISH_PIPE and the debugger command are required\n');
    return 2;
  }
  const privateKey = config.privateKeyPath && fs.existsSync(config.privateKeyPath) ? fs.readFileSync(config.privateKeyPath) : undefined;
  // No prompts here: the extension pinned the host key before handing over.
  const session = await SshConnection.open(config, { privateKey, agent: config.agent },
    async fingerprint => fingerprint === config.fingerprint);
  const channel = await session.channel(command);

  const filter = new DapFilter();
  process.stdin.on('data', (chunk: Buffer) => {
    const out = filter.push(chunk);
    if (out.length) channel.write(out);
  });
  process.stdin.on('end', () => {
    const rest = filter.flush();
    if (rest.length) channel.write(rest);
    channel.end();
  });
  channel.pipe(process.stdout);
  channel.stderr.pipe(process.stderr);
  return new Promise(resolve => channel.on('close', (code: number | null) => {
    session.close();
    resolve(code ?? 0);
  }));
}

main().then(code => process.exit(code), err => {
  process.stderr.write(`maui-sailfish pipe: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
