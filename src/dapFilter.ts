// VS Code sends SHA384/SHA512 source checksums with breakpoint requests, but vsdbg only accepts MD5/SHA1/SHA256
// and rejects the whole setBreakpoints request (error 3001), so every breakpoint stays unbound. This relay drops
// the unsupported checksums and passes everything else through; a frame it cannot parse goes through unchanged.

const ALLOWED = new Set(['MD5', 'SHA1', 'SHA256']);
const BREAKPOINT_COMMANDS = new Set(['setBreakpoints', 'setFunctionBreakpoints', 'setInstructionBreakpoints']);
const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER = 16384;

/** Returns the body with unsupported checksums removed, or the same buffer when nothing changes. */
export function stripChecksums(body: Buffer): Buffer {
  let message: any;
  try {
    message = JSON.parse(body.toString('utf8'));
  } catch {
    return body;
  }
  const source = message?.type === 'request' && BREAKPOINT_COMMANDS.has(message.command)
    ? message.arguments?.source
    : undefined;
  if (!source || typeof source !== 'object' || !Array.isArray(source.checksums)) {
    return body;
  }
  const kept = source.checksums.filter((c: any) => c && typeof c === 'object' && ALLOWED.has(c.algorithm));
  if (kept.length === source.checksums.length) {
    return body;
  }
  if (kept.length > 0) {
    source.checksums = kept;
  } else {
    delete source.checksums;
  }
  return Buffer.from(JSON.stringify(message), 'utf8');
}

/** Incremental DAP frame rewriter: feed it chunks, it returns the bytes to forward. */
export class DapFilter {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: Buffer[] = [];
    for (;;) {
      const headerEnd = this.pending.indexOf(HEADER_END);
      if (headerEnd < 0) {
        if (this.pending.length > MAX_HEADER) {
          out.push(this.pending);   // not DAP at all: stop buffering
          this.pending = Buffer.alloc(0);
        }
        break;
      }
      const headers = this.pending.subarray(0, headerEnd).toString('latin1');
      const length = /content-length:[ \t]*(\d+)/i.exec(headers);
      if (!length) {
        out.push(this.pending.subarray(0, headerEnd + HEADER_END.length));
        this.pending = this.pending.subarray(headerEnd + HEADER_END.length);
        continue;
      }
      const bodyStart = headerEnd + HEADER_END.length;
      const bodyEnd = bodyStart + Number(length[1]);
      if (this.pending.length < bodyEnd) {
        break;   // wait for the rest of the body
      }
      const body = this.pending.subarray(bodyStart, bodyEnd);
      const rewritten = stripChecksums(body);
      out.push(rewritten === body
        ? this.pending.subarray(0, bodyEnd)
        : Buffer.concat([Buffer.from(`Content-Length: ${rewritten.length}\r\n\r\n`), rewritten]));
      this.pending = this.pending.subarray(bodyEnd);
    }
    return Buffer.concat(out);
  }

  /** Whatever is left when the input ends (a partial frame) goes out as is. */
  flush(): Buffer {
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    return rest;
  }
}
