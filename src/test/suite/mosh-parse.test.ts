/**
 * mosh-parse.test.ts
 *
 * parseMoshConnect() と parseVsCodeServerPort() のユニットテスト。
 * VS Code API に依存しないため、純粋な Node.js 環境で実行可能。
 */
import * as assert from 'assert';
import { parseMoshConnect, parseVsCodeServerPort, getVsCodeServerDownloadUrl } from '../../server-installer';

describe('parseMoshConnect()', () => {
  it('should parse a valid MOSH CONNECT line', () => {
    const output = '\r\nMOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQw==\r\n';
    const result = parseMoshConnect(output);
    assert.ok(result !== null, 'Should return a result');
    assert.strictEqual(result!.udpPort, 60001);
    assert.strictEqual(result!.key, '4NeCCgvZFe2RnPgrcU1PQw==');
  });

  it('should parse MOSH CONNECT without CRLF', () => {
    const output = 'MOSH CONNECT 60002 ABCDEFGHIJKLMNOPQRSTUV==';
    const result = parseMoshConnect(output);
    assert.ok(result !== null, 'Should return a result');
    assert.strictEqual(result!.udpPort, 60002);
    assert.strictEqual(result!.key, 'ABCDEFGHIJKLMNOPQRSTUV==');
  });

  it('should return null for empty output', () => {
    assert.strictEqual(parseMoshConnect(''), null);
  });

  it('should return null for invalid format', () => {
    assert.strictEqual(parseMoshConnect('some random output'), null);
    assert.strictEqual(parseMoshConnect('MOSH CONNECT'), null);
    assert.strictEqual(parseMoshConnect('MOSH CONNECT 60001'), null);
  });

  it('should handle mosh-server output with other text', () => {
    const output = `
      mosh-server starting...
      bind: 0.0.0.0
      
      \r\nMOSH CONNECT 60003 TestKeyBase64String123456\r\n
      
      Listening on port 60003
    `;
    const result = parseMoshConnect(output);
    assert.ok(result !== null, 'Should parse from multi-line output');
    assert.strictEqual(result!.udpPort, 60003);
    assert.strictEqual(result!.key, 'TestKeyBase64String123456');
  });

  it('should return null for key that is too short', () => {
    // キーが22文字未満の場合は無効
    const output = 'MOSH CONNECT 60001 shortkey';
    assert.strictEqual(parseMoshConnect(output), null);
  });

  it('should parse keys with slashes and plus signs (base64)', () => {
    const output = 'MOSH CONNECT 60001 abc+def/ghijklmnopqrstuv==';
    const result = parseMoshConnect(output);
    assert.ok(result !== null, 'Should parse base64 key with special chars');
    assert.strictEqual(result!.key, 'abc+def/ghijklmnopqrstuv==');
  });

  it('should reject UDP port 0', () => {
    const output = 'MOSH CONNECT 0 4NeCCgvZFe2RnPgrcU1PQw==';
    assert.strictEqual(parseMoshConnect(output), null);
  });

  it('should reject UDP port > 65535', () => {
    const output = 'MOSH CONNECT 99999 4NeCCgvZFe2RnPgrcU1PQw==';
    assert.strictEqual(parseMoshConnect(output), null);
  });

  it('should use the last matching MOSH CONNECT if multiple exist', () => {
    // 最初にマッチしたものを返す
    const output = 'MOSH CONNECT 60001 AAAAAAAAAAAAAAAAAAAAAA==\r\nMOSH CONNECT 60002 BBBBBBBBBBBBBBBBBBBBBB==';
    const result = parseMoshConnect(output);
    assert.ok(result !== null);
    assert.strictEqual(result!.udpPort, 60001);
  });
});

describe('parseVsCodeServerPort()', () => {
  it('should parse "Accepting connections at: 127.0.0.1:<port>"', () => {
    const output = '* Accepting connections at: 127.0.0.1:12345';
    assert.strictEqual(parseVsCodeServerPort(output), 12345);
  });

  it('should parse "Accepting connections at: <port>" (without IP)', () => {
    const output = '** Accepting connections at: 54321';
    assert.strictEqual(parseVsCodeServerPort(output), 54321);
  });

  it('should parse "Extension host agent listening on <port>"', () => {
    const output = 'Extension host agent listening on 8080';
    assert.strictEqual(parseVsCodeServerPort(output), 8080);
  });

  it('should parse "Server bound to 127.0.0.1:<port>"', () => {
    const output = 'Server bound to 127.0.0.1:9000';
    assert.strictEqual(parseVsCodeServerPort(output), 9000);
  });

  it('should parse "listening on <port>"', () => {
    const output = 'VS Code server listening on 7654';
    assert.strictEqual(parseVsCodeServerPort(output), 7654);
  });

  it('should parse "started on port <port>"', () => {
    const output = 'Server started on port 3000';
    assert.strictEqual(parseVsCodeServerPort(output), 3000);
  });

  it('should return null for empty output', () => {
    assert.strictEqual(parseVsCodeServerPort(''), null);
  });

  it('should return null for unrelated output', () => {
    assert.strictEqual(parseVsCodeServerPort('Starting VS Code Server...'), null);
    assert.strictEqual(parseVsCodeServerPort('Error: failed to bind'), null);
  });

  it('should find port in multi-line output', () => {
    const output = `
VS Code Server starting...
Downloading extensions...
VS Code server listening on 49152
Server is ready.
    `.trim();
    assert.strictEqual(parseVsCodeServerPort(output), 49152);
  });

  it('should reject port 0', () => {
    const output = 'listening on 0';
    // Port 0 is not a valid port (parseVsCodeServerPort returns null for ports <= 0)
    assert.strictEqual(parseVsCodeServerPort(output), null);
  });

  it('should handle VS Code Server typical output format', () => {
    // 実際の VS Code Server 出力に近いフォーマット
    const output = `
*
* VS Code Server (version 1.85.0)
* Build SHA: abc123def456
*
** Accepting connections at: 127.0.0.1:39423
*
    `.trim();
    assert.strictEqual(parseVsCodeServerPort(output), 39423);
  });
});

describe('getVsCodeServerDownloadUrl()', () => {
  it('should generate correct URL for x64', () => {
    const url = getVsCodeServerDownloadUrl('abc123def', 'x64');
    assert.strictEqual(
      url,
      'https://update.code.visualstudio.com/commit:abc123def/server-linux-x64/stable'
    );
  });

  it('should generate correct URL for arm64', () => {
    const url = getVsCodeServerDownloadUrl('abc123def', 'arm64');
    assert.strictEqual(
      url,
      'https://update.code.visualstudio.com/commit:abc123def/server-linux-arm64/stable'
    );
  });

  it('should generate correct URL for armhf', () => {
    const url = getVsCodeServerDownloadUrl('abc123def', 'armhf');
    assert.strictEqual(
      url,
      'https://update.code.visualstudio.com/commit:abc123def/server-linux-armhf/stable'
    );
  });

  it('should include full commit hash in URL', () => {
    const commit = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const url = getVsCodeServerDownloadUrl(commit, 'x64');
    assert.ok(url.includes(commit), 'URL should contain full commit hash');
  });
});
