import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { DapFilter, stripChecksums } from '../src/dapFilter';

const frame = (message: object) => {
  const body = Buffer.from(JSON.stringify(message));
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
};
/** Splits a byte stream into its DAP bodies. */
const bodies = (bytes: Buffer): any[] => {
  const out: any[] = [];
  let at = 0;
  while (at < bytes.length) {
    const end = bytes.indexOf('\r\n\r\n', at);
    const length = Number(/Content-Length: (\d+)/.exec(bytes.subarray(at, end).toString())![1]);
    out.push(JSON.parse(bytes.subarray(end + 4, end + 4 + length).toString()));
    at = end + 4 + length;
  }
  return out;
};
const bodyOf = (bytes: Buffer) => bodies(bytes)[0];

const breakpoints = (checksums: object[]) => ({
  seq: 3, type: 'request', command: 'setBreakpoints',
  arguments: { source: { path: '/app/MainPage.cs', checksums }, breakpoints: [{ line: 12 }] },
});

test('drops the checksums vsdbg rejects and keeps the rest', () => {
  const out = new DapFilter().push(frame(breakpoints([
    { algorithm: 'SHA256', checksum: 'aa' }, { algorithm: 'SHA384', checksum: 'bb' }])));
  assert.deepEqual(bodyOf(out).arguments.source.checksums, [{ algorithm: 'SHA256', checksum: 'aa' }]);
});

test('removes the checksums field when nothing supported is left', () => {
  const out = new DapFilter().push(frame(breakpoints([{ algorithm: 'SHA512', checksum: 'cc' }])));
  assert.equal('checksums' in bodyOf(out).arguments.source, false);
});

test('passes other frames through byte for byte', () => {
  const original = frame({ seq: 1, type: 'request', command: 'initialize', arguments: { clientID: 'vscode' } });
  assert.deepEqual(new DapFilter().push(original), original);
});

test('reassembles frames split across chunks and several frames in one chunk', () => {
  const a = frame(breakpoints([{ algorithm: 'SHA384', checksum: 'x' }]));
  const b = frame({ seq: 4, type: 'request', command: 'threads' });
  const all = Buffer.concat([a, b]);
  const filter = new DapFilter();
  const out = Buffer.concat([filter.push(all.subarray(0, 7)), filter.push(all.subarray(7, a.length + 3)), filter.push(all.subarray(a.length + 3))]);
  const [first, second] = bodies(out);
  assert.equal('checksums' in first.arguments.source, false);
  assert.deepEqual(second, { seq: 4, type: 'request', command: 'threads' });
});

test('malformed JSON is forwarded unchanged', () => {
  const body = Buffer.from('{not json');
  assert.equal(stripChecksums(body), body);
});
