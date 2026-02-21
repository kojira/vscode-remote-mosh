/**
 * server-installer.test.ts
 *
 * server-installer.ts のモックテスト。
 * SSH クライアントを sinon でモックし、各関数の動作を検証する。
 */
import * as assert from 'assert';
import * as sinon from 'sinon';
import { EventEmitter } from 'events';
import {
  detectArchitecture,
  checkVsCodeServerInstalled,
  installVsCodeServer,
  startVsCodeServer,
  execRemote,
  parseMoshConnect,
  parseVsCodeServerPort,
} from '../../server-installer';

// ---------------------------------------------------------------------------
// SSH クライアントのモックファクトリ
// ---------------------------------------------------------------------------

/**
 * 指定したコマンドに対して指定した出力を返すモック SSH クライアントを作成する。
 *
 * @param responses コマンドと応答のマップ
 *   key: 実行されたコマンド（部分一致）
 *   value: { stdout, stderr, exitCode }
 */
interface MockResponse {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  delay?: number;
}

function createMockSshClient(responses: Map<string, MockResponse>): sinon.SinonStubbedInstance<{ exec: Function }> {
  const mockClient = {
    exec: sinon.stub(),
  };

  mockClient.exec.callsFake((command: string, opts: unknown, callback: Function) => {
    // レスポンスを探す
    let response: Required<MockResponse> = { stdout: '', stderr: '', exitCode: 0, delay: 0 };
    for (const [pattern, resp] of responses.entries()) {
      if (command.includes(pattern)) {
        response = { ...response, ...resp };
        break;
      }
    }

    const stream = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
    };
    stream.stderr = new EventEmitter();

    // デフォルトコールバック形式
    if (typeof opts === 'function') {
      callback = opts;
    }

    callback(null, stream);

    const emit = () => {
      if (response.stdout) {
        stream.emit('data', Buffer.from(response.stdout));
      }
      if (response.stderr) {
        stream.stderr.emit('data', Buffer.from(response.stderr));
      }
      stream.emit('close', response.exitCode ?? 0);
    };

    if (response.delay && response.delay > 0) {
      setTimeout(emit, response.delay);
    } else {
      // 次の tick で発火（同期的な問題を避ける）
      process.nextTick(emit);
    }
  });

  return mockClient as unknown as sinon.SinonStubbedInstance<{ exec: Function }>;
}

/**
 * exec コールバックで即座にエラーを返すモック SSH クライアント。
 */
function createErrorSshClient(errorMessage: string): sinon.SinonStubbedInstance<{ exec: Function }> {
  const mockClient = { exec: sinon.stub() };
  mockClient.exec.callsFake((_command: string, _opts: unknown, callback: Function) => {
    if (typeof _opts === 'function') {
      callback = _opts;
    }
    callback(new Error(errorMessage));
  });
  return mockClient as unknown as sinon.SinonStubbedInstance<{ exec: Function }>;
}

// ---------------------------------------------------------------------------
// execRemote() のテスト
// ---------------------------------------------------------------------------

describe('execRemote()', () => {
  it('should execute a command and return stdout', async () => {
    const responses = new Map([
      ['echo hello', { stdout: 'hello\n', exitCode: 0 }],
    ]);
    const mockSsh = createMockSshClient(responses);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await execRemote(mockSsh as any, 'echo hello');
    assert.strictEqual(result, 'hello\n');
  });

  it('should throw when command exits with non-zero code', async () => {
    const responses = new Map([
      ['failing_command', { stdout: '', stderr: 'command not found', exitCode: 127 }],
    ]);
    const mockSsh = createMockSshClient(responses);

    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => execRemote(mockSsh as any, 'failing_command'),
      (err: Error) => {
        assert.ok(err.message.includes('127'), 'Error should mention exit code');
        return true;
      }
    );
  });

  it('should throw when SSH exec returns error', async () => {
    const mockSsh = createErrorSshClient('Connection closed');

    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => execRemote(mockSsh as any, 'any command'),
      (err: Error) => {
        assert.ok(err.message.includes('exec error') || err.message.includes('Connection closed'));
        return true;
      }
    );
  });

  it('should throw on timeout', async () => {
    // タイムアウトテスト: モックが応答を返さない
    const mockClient = { exec: sinon.stub() };
    mockClient.exec.callsFake((_command: string, _opts: unknown, callback: Function) => {
      if (typeof _opts === 'function') {
        callback = _opts;
      }
      // ストリームを作るが何もemitしない（タイムアウトをシミュレート）
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      stream.stderr = new EventEmitter();
      callback(null, stream);
      // 何もemitしない → タイムアウト
    });

    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => execRemote(mockClient as any, 'slow_command', 100),
      (err: Error) => {
        assert.ok(err.message.includes('timed out'), `Expected timeout error, got: ${err.message}`);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// detectArchitecture() のテスト
// ---------------------------------------------------------------------------

describe('detectArchitecture()', () => {
  it('should detect x64 from "x86_64"', async () => {
    const responses = new Map([
      ['uname -m', { stdout: 'x86_64\n', exitCode: 0 }],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await detectArchitecture(createMockSshClient(responses) as any);
    assert.strictEqual(result, 'x64');
  });

  it('should detect arm64 from "aarch64"', async () => {
    const responses = new Map([
      ['uname -m', { stdout: 'aarch64\n', exitCode: 0 }],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await detectArchitecture(createMockSshClient(responses) as any);
    assert.strictEqual(result, 'arm64');
  });

  it('should detect arm64 from "arm64"', async () => {
    const responses = new Map([
      ['uname -m', { stdout: 'arm64\n', exitCode: 0 }],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await detectArchitecture(createMockSshClient(responses) as any);
    assert.strictEqual(result, 'arm64');
  });

  it('should detect armhf from "armv7l"', async () => {
    const responses = new Map([
      ['uname -m', { stdout: 'armv7l\n', exitCode: 0 }],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await detectArchitecture(createMockSshClient(responses) as any);
    assert.strictEqual(result, 'armhf');
  });

  it('should default to x64 for unknown architecture', async () => {
    const responses = new Map([
      ['uname -m', { stdout: 'mips64\n', exitCode: 0 }],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await detectArchitecture(createMockSshClient(responses) as any);
    assert.strictEqual(result, 'x64');
  });

  it('should trim whitespace from uname output', async () => {
    const responses = new Map([
      ['uname -m', { stdout: '  x86_64  \n', exitCode: 0 }],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await detectArchitecture(createMockSshClient(responses) as any);
    assert.strictEqual(result, 'x64');
  });
});

// ---------------------------------------------------------------------------
// checkVsCodeServerInstalled() のテスト
// ---------------------------------------------------------------------------

describe('checkVsCodeServerInstalled()', () => {
  const testCommit = 'abc123def456abc123def456abc123def456abc1';

  it('should return true when server.sh exists', async () => {
    const responses = new Map([
      ['test -f', { stdout: 'exists\n', exitCode: 0 }],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await checkVsCodeServerInstalled(createMockSshClient(responses) as any, testCommit);
    assert.strictEqual(result, true);
  });

  it('should return false when server.sh does not exist', async () => {
    const responses = new Map([
      ['test -f', { stdout: 'missing\n', exitCode: 0 }],
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await checkVsCodeServerInstalled(createMockSshClient(responses) as any, testCommit);
    assert.strictEqual(result, false);
  });

  it('should return false when SSH command fails', async () => {
    const mockSsh = createErrorSshClient('Connection lost');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await checkVsCodeServerInstalled(mockSsh as any, testCommit);
    assert.strictEqual(result, false);
  });
});

// ---------------------------------------------------------------------------
// startVsCodeServer() のテスト
// ---------------------------------------------------------------------------

describe('startVsCodeServer()', () => {
  const testCommit = 'abc123def456abc123def456abc123def456abc1';
  const testToken = 'test-connection-token-12345';

  it('should parse port from "Accepting connections at" output', async () => {
    const serverOutput = '** Accepting connections at: 127.0.0.1:39423\n';

    const mockClient = { exec: sinon.stub() };
    mockClient.exec.callsFake((_cmd: string, _opts: unknown, callback: Function) => {
      if (typeof _opts === 'function') {
        callback = _opts;
      }
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      stream.stderr = new EventEmitter();
      callback(null, stream);
      // 少し遅延してからデータを送る
      setTimeout(() => {
        stream.emit('data', Buffer.from(serverOutput));
        // サーバーは終了しない（プロセスとして継続実行）
      }, 10);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await startVsCodeServer(mockClient as any, testCommit, testToken);
    assert.strictEqual(result.port, 39423);
    assert.strictEqual(result.connectionToken, testToken);
  });

  it('should parse port from "Extension host agent listening on" output', async () => {
    const serverOutput = 'Extension host agent listening on 54321\n';

    const mockClient = { exec: sinon.stub() };
    mockClient.exec.callsFake((_cmd: string, _opts: unknown, callback: Function) => {
      if (typeof _opts === 'function') {
        callback = _opts;
      }
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      stream.stderr = new EventEmitter();
      callback(null, stream);
      setTimeout(() => {
        stream.stderr.emit('data', Buffer.from(serverOutput));
      }, 10);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await startVsCodeServer(mockClient as any, testCommit, testToken);
    assert.strictEqual(result.port, 54321);
  });

  it('should reject when server process exits without port', async () => {
    const mockClient = { exec: sinon.stub() };
    mockClient.exec.callsFake((_cmd: string, _opts: unknown, callback: Function) => {
      if (typeof _opts === 'function') {
        callback = _opts;
      }
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      stream.stderr = new EventEmitter();
      callback(null, stream);
      setTimeout(() => {
        stream.emit('data', Buffer.from('VS Code Server error: segfault\n'));
        stream.emit('close', 1);  // 非ゼロ終了
      }, 10);
    });

    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => startVsCodeServer(mockClient as any, testCommit, testToken),
      (err: Error) => {
        assert.ok(
          err.message.includes('exited') || err.message.includes('exit'),
          `Expected exit error, got: ${err.message}`
        );
        return true;
      }
    );
  });

  it('should reject when SSH exec fails', async () => {
    const mockSsh = createErrorSshClient('SSH exec failed');

    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => startVsCodeServer(mockSsh as any, testCommit, testToken),
      (err: Error) => {
        assert.ok(err.message.includes('Failed to exec') || err.message.includes('SSH exec failed'));
        return true;
      }
    );
  });

  it('should call onProgress callback during startup', async () => {
    const progressMessages: string[] = [];
    const serverOutput = '** Accepting connections at: 127.0.0.1:11111\n';

    const mockClient = { exec: sinon.stub() };
    mockClient.exec.callsFake((_cmd: string, _opts: unknown, callback: Function) => {
      if (typeof _opts === 'function') {
        callback = _opts;
      }
      const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      stream.stderr = new EventEmitter();
      callback(null, stream);
      setTimeout(() => {
        stream.emit('data', Buffer.from(serverOutput));
      }, 10);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await startVsCodeServer(mockClient as any, testCommit, testToken, (msg) => {
      progressMessages.push(msg);
    });

    assert.ok(progressMessages.length > 0, 'Progress messages should have been called');
    assert.ok(
      progressMessages.some(m => m.toLowerCase().includes('start') || m.includes('11111')),
      `Expected start/port message, got: ${progressMessages.join(', ')}`
    );
  });
});

// ---------------------------------------------------------------------------
// installVsCodeServer() のテスト
// ---------------------------------------------------------------------------

describe('installVsCodeServer()', () => {
  const testCommit = 'abc123def456abc123def456abc123def456abc1';

  it('should succeed when download and extract succeed', async () => {
    const responses = new Map([
      // ダウンロードスクリプトに含まれる文字列でマッチ
      ['mkdir', {
        stdout: 'VS Code Server installed: ~/.vscode-server/bin/abc123\n',
        exitCode: 0,
      }],
    ]);
    const progressMessages: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assert.doesNotReject(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => installVsCodeServer(createMockSshClient(responses) as any, testCommit, 'x64', (msg) => {
        progressMessages.push(msg);
      })
    );
  });

  it('should throw when download fails', async () => {
    const responses = new Map([
      ['mkdir', { stdout: '', stderr: 'curl: (6) Could not resolve host', exitCode: 6 }],
    ]);

    await assert.rejects(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => installVsCodeServer(createMockSshClient(responses) as any, testCommit, 'x64')
    );
  });

  it('should call onProgress during installation', async () => {
    const responses = new Map([
      ['mkdir', { stdout: 'VS Code Server installed\n', exitCode: 0 }],
    ]);
    const progressMessages: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await installVsCodeServer(createMockSshClient(responses) as any, testCommit, 'x64', (msg) => {
      progressMessages.push(msg);
    });

    assert.ok(
      progressMessages.some(m => m.toLowerCase().includes('download') || m.toLowerCase().includes('install')),
      `Expected download/install progress, got: ${progressMessages.join(', ')}`
    );
  });
});

// ---------------------------------------------------------------------------
// エラーハンドリングの統合テスト
// ---------------------------------------------------------------------------

describe('Error Handling', () => {
  it('parseMoshConnect should handle malformed base64 gracefully', () => {
    // スペースを含む無効なbase64
    const invalidOutput = 'MOSH CONNECT 60001 invalid key with spaces here!!!';
    assert.strictEqual(parseMoshConnect(invalidOutput), null);
  });

  it('parseVsCodeServerPort should handle garbage output gracefully', () => {
    const garbage = '\x00\x01\x02\x03binary data';
    // クラッシュしないことを確認
    const result = parseVsCodeServerPort(garbage);
    // null または数値であること
    assert.ok(result === null || typeof result === 'number');
  });

  it('parseVsCodeServerPort should not extract very large port numbers', () => {
    const output = 'listening on 99999';
    // 65535 を超えるポートは無効
    const result = parseVsCodeServerPort(output);
    assert.strictEqual(result, null);
  });

  it('parseMoshConnect should handle Windows-style CRLF', () => {
    const output = 'MOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQw==\r\n';
    const result = parseMoshConnect(output);
    assert.ok(result !== null, 'Should parse with CRLF');
    assert.strictEqual(result!.udpPort, 60001);
  });

  it('multiple calls to parseMoshConnect should be independent', () => {
    const output1 = 'MOSH CONNECT 60001 AAAAAAAAAAAAAAAAAAAAAA==';
    const output2 = 'MOSH CONNECT 60002 BBBBBBBBBBBBBBBBBBBBBB==';
    const result1 = parseMoshConnect(output1);
    const result2 = parseMoshConnect(output2);
    assert.ok(result1 !== null);
    assert.ok(result2 !== null);
    assert.strictEqual(result1!.udpPort, 60001);
    assert.strictEqual(result2!.udpPort, 60002);
    // 相互に影響しないこと
    assert.notStrictEqual(result1, result2);
  });
});

// ---------------------------------------------------------------------------
// 回帰テスト: 実際の VS Code Server 出力パターン
// ---------------------------------------------------------------------------

describe('Regression Tests: Real-world Output Patterns', () => {
  it('should parse VS Code Server 1.85.x output format', () => {
    const output = `

*
* VS Code Server (version 1.85.0)
* Build SHA: 0ee08df0cf4527e40edc9aa28f4b5bd38bbff2b2
*
** Accepting connections at: 127.0.0.1:49152
*

    `.trim();
    assert.strictEqual(parseVsCodeServerPort(output), 49152);
  });

  it('should parse mosh-server 1.4.0 MOSH CONNECT format', () => {
    // mosh-server の実際の出力
    const output = '\r\n\r\nMOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQw\r\n\r\n';
    const result = parseMoshConnect(output);
    assert.ok(result !== null);
    assert.strictEqual(result!.udpPort, 60001);
    assert.strictEqual(result!.key, '4NeCCgvZFe2RnPgrcU1PQw');
  });

  it('should handle mosh-server on non-standard port', () => {
    const output = 'MOSH CONNECT 61000 ValidBase64KeyHere12345678==';
    const result = parseMoshConnect(output);
    assert.ok(result !== null);
    assert.strictEqual(result!.udpPort, 61000);
  });
});
