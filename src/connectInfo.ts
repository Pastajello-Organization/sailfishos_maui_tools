/** A device read from the shell tooling's connect.info ("IP:", "user:", "password:" lines). */
export interface ConnectInfo {
  host: string;
  user: string;
  password?: string;
}

/** Parses connect.info; template placeholders ("<sshPassword>") count as absent, the last line of a key wins. */
export function parseConnectInfo(text: string): ConnectInfo | undefined {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z]+):\s*(.*?)\s*$/.exec(raw);
    if (!match || match[2] === '' || /^<.*>$/.test(match[2])) {
      continue;
    }
    values.set(match[1].toLowerCase(), match[2]);
  }
  const host = values.get('ip') ?? values.get('host');
  if (!host || !isHost(host)) {
    return undefined;
  }
  return { host, user: values.get('user') ?? 'defaultuser', password: values.get('password') };
}

/** A full dotted IPv4 address or a host name; a truncated "192." is neither. */
export function isHost(value: string): boolean {
  if (/^[\d.]+$/.test(value)) {
    const parts = value.split('.');
    return parts.length === 4 && parts.every(p => p !== '' && Number(p) <= 255);
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(value) || /^[0-9A-Fa-f:]+$/.test(value);
}
