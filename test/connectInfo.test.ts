import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConnectInfo } from '../src/connectInfo';
import { shq } from '../src/remoteScripts';

test('reads IP, user and password', () => {
  assert.deepEqual(parseConnectInfo('IP: 192.168.1.172\nuser: defaultuser\npassword: s3cret\n'),
    { host: '192.168.1.172', user: 'defaultuser', password: 's3cret' });
});

test('host is an alias of IP, user defaults to defaultuser, CRLF is fine', () => {
  assert.deepEqual(parseConnectInfo('host: phone.local\r\n'), { host: 'phone.local', user: 'defaultuser', password: undefined });
});

test('template placeholders count as absent', () => {
  assert.equal(parseConnectInfo('IP: <deviceIp>\npassword: <sshPassword>\n'), undefined);
  assert.equal(parseConnectInfo('IP: 10.0.0.2\npassword: <sshPassword>\n')?.password, undefined);
});

test('shell quoting survives single quotes', () => {
  assert.equal(shq(`it's`), `'it'\\''s'`);
});

test('a truncated address is not a device', () => {
  assert.equal(parseConnectInfo('IP: 192.\nuser: defaultuser\n'), undefined);
  assert.equal(parseConnectInfo('IP: 192.168.1.300\n'), undefined);
});
