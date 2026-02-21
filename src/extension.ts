/**
 * extension.ts
 *
 * VS Code Remote-Mosh 拡張機能のエントリーポイント。
 *
 * ## アーキテクチャ概要
 *
 * ```
 * activate()
 *   └─ registerRemoteAuthorityResolver('mosh', MoshRemoteAuthorityResolver)
 *         └─ resolve(authority, context)
 *               ├─ SSH でリモートに接続
 *               ├─ mosh-server を起動
 *               ├─ "MOSH CONNECT <port> <key>" を解析
 *               └─ ManagedResolvedAuthority を返す
 *                     └─ makeConnection()
 *                           └─ MoshMessagePassing（ManagedMessagePassing 実装）
 *                                 ├─ MoshClientWrapper（UDP socket + WASM）
 *                                 └─ VS Code RPC ⇄ mosh バイトストリーム
 * ```
 */
import * as vscode from 'vscode';
import { initLogger, logger } from './logger';
import { getMoshConfig, parseAuthority } from './config';
import { MoshClientWrapper } from './mosh-client';

// SSH クライアント（接続確立用）
// TODO: Phase 2 で ExecServer ベースの SSH 実装に置き換える
import { Client as SshClient, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Extension Lifecycle
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);
  logger.info('Remote-Mosh extension activating...');

  // RemoteAuthorityResolver を登録
  const resolver = new MoshRemoteAuthorityResolver(context);
  context.subscriptions.push(
    (vscode.workspace as typeof vscode.workspace).registerRemoteAuthorityResolver('mosh', resolver)
  );

  // コマンド: 出力チャンネルを開く
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteMosh.showLog', () => {
      logger.show();
    })
  );

  logger.info('Remote-Mosh extension activated. Authority prefix: mosh');
}

export function deactivate(): void {
  logger.info('Remote-Mosh extension deactivating...');
}

// ---------------------------------------------------------------------------
// MoshRemoteAuthorityResolver（Proposed API 実装）
// ---------------------------------------------------------------------------

/**
 * mosh プレフィックス付きリモート接続を解決するリゾルバー。
 *
 * VS Code が `vscode-remote://mosh+user@host/path` を開く際に呼ばれる。
 */
class MoshRemoteAuthorityResolver implements vscode.RemoteAuthorityResolver {
  private readonly _context: vscode.ExtensionContext;

  /** 進行中の mosh セッション（authority → セッション情報） */
  private readonly _sessions = new Map<string, MoshSession>();

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    this._context.subscriptions.push({
      dispose: () => this._disposeAll(),
    });
  }

  // -------------------------------------------------------------------------
  // RemoteAuthorityResolver.resolve()
  // -------------------------------------------------------------------------

  async resolve(
    authority: string,
    context: vscode.RemoteAuthorityResolverContext
  ): Promise<vscode.ResolverResult> {
    logger.info(
      `resolve() called: authority="${authority}", attempt=${context.resolveAttempt}`
    );

    const config = getMoshConfig();
    const { user, host, sshPort } = parseAuthority(authority);
    const sshUser = user || config.defaultUser;

    logger.info(`Target: ${sshUser}@${host}:${sshPort} (mosh port: ${config.defaultPort})`);

    // 再接続の場合は既存セッションをクリーンアップ
    if (context.resolveAttempt > 0) {
      logger.info(`Re-connecting (attempt ${context.resolveAttempt})...`);
      const existing = this._sessions.get(authority);
      if (existing) {
        existing.dispose();
        this._sessions.delete(authority);
      }
    }

    // ステータスバーに接続状態を表示
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Remote-Mosh: Connecting to ${sshUser}@${host}...`,
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Starting SSH session...' });

        // SSH → mosh-server 起動 → "MOSH CONNECT <port> <key>" 取得
        const moshInfo = await this._startMoshServer({
          host,
          port: sshPort,
          username: sshUser,
          identityFile: config.identityFile,
          moshServerPath: config.serverPath,
          preferredUdpPort: config.defaultPort,
        });

        logger.info(
          `mosh-server started: UDP port=${moshInfo.udpPort}, key=${moshInfo.key.substring(0, 8)}...`
        );
        progress.report({ message: `mosh-server on UDP ${moshInfo.udpPort}` });

        // セッション情報を保存
        const session = new MoshSession({
          host,
          udpPort: moshInfo.udpPort,
          keyBase64: moshInfo.key,
          mtu: config.mtu,
        });
        this._sessions.set(authority, session);
      }
    );

    const session = this._sessions.get(authority);
    if (!session) {
      throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(
        'Failed to start mosh-server'
      );
    }

    // ManagedResolvedAuthority を返す
    // makeConnection は VS Code が実際に接続チャンネルを開くときに呼ばれる
    const connectionToken = crypto.randomUUID();
    return new vscode.ManagedResolvedAuthority(
      () => session.makeConnection(),
      connectionToken
    );
  }

  // -------------------------------------------------------------------------
  // Private: mosh-server 起動（SSH 経由）
  // -------------------------------------------------------------------------

  /**
   * SSH でリモートに接続し、mosh-server を起動して接続情報を返す。
   *
   * mosh-server の出力形式:
   * `\r\nMOSH CONNECT <udpPort> <base64key>\r\n`
   *
   * @returns UDP ポートと AES-128 鍵（Base64）
   */
  private async _startMoshServer(opts: {
    host: string;
    port: number;
    username: string;
    identityFile: string;
    moshServerPath: string;
    preferredUdpPort: number;
  }): Promise<{ udpPort: number; key: string }> {
    const { host, port, username, identityFile, moshServerPath, preferredUdpPort } = opts;

    return new Promise<{ udpPort: number; key: string }>((resolve, reject) => {
      const ssh = new SshClient();
      let output = '';
      let resolved = false;

      const cleanup = (err?: Error): void => {
        if (!resolved) {
          resolved = true;
          ssh.end();
          if (err) {
            reject(err);
          }
        }
      };

      ssh.on('ready', () => {
        logger.debug('SSH connection ready');

        // mosh-server 起動コマンド
        // -p: 優先 UDP ポート
        // -s: stdout に "MOSH CONNECT ..." を出力するモード
        // -- /bin/sh -c 'exec ...': ログイン shell を介さずに直接実行
        const moshCmd = [
          moshServerPath,
          'new',
          '-s',
          '-p', String(preferredUdpPort),
          '--',
          // vscode-server への接続は makeConnection() で行うため
          // mosh-server はシェルを起動せずに待機する
          // TODO: Phase 2 で vscode-server を起動するコマンドに変更
          '/bin/bash',
        ].join(' ');

        logger.debug(`Starting mosh-server: ${moshCmd}`);

        ssh.exec(moshCmd, { pty: false }, (err, stream) => {
          if (err) {
            cleanup(err);
            return;
          }

          stream.on('data', (data: Buffer) => {
            output += data.toString('utf8');
            logger.trace(`mosh-server stdout: ${data.toString('utf8').trim()}`);

            // "MOSH CONNECT <port> <key>" を探す
            const match = output.match(/MOSH CONNECT (\d+) ([A-Za-z0-9+/=]{22,})/);
            if (match && !resolved) {
              resolved = true;
              const udpPort = parseInt(match[1], 10);
              const key = match[2];
              logger.info(`mosh-server: UDP port=${udpPort}, key=${key.substring(0, 8)}...`);
              ssh.end();
              resolve({ udpPort, key });
            }
          });

          stream.stderr.on('data', (data: Buffer) => {
            logger.debug(`mosh-server stderr: ${data.toString('utf8').trim()}`);
          });

          stream.on('close', (code: number | null) => {
            if (!resolved) {
              cleanup(
                new Error(
                  `mosh-server exited with code ${code} before outputting "MOSH CONNECT". ` +
                  `Output: ${output.trim()}`
                )
              );
            }
          });
        });
      });

      ssh.on('error', (err: Error) => {
        logger.error('SSH error:', err.message);
        cleanup(err);
      });

      // SSH 接続設定を組み立てる
      const sshConfig: ConnectConfig = {
        host,
        port,
        username,
        // タイムアウト: 15 秒
        readyTimeout: 15_000,
      };

      // 秘密鍵ファイルが指定されていれば読み込む
      if (identityFile && fs.existsSync(identityFile)) {
        logger.debug(`Using identity file: ${identityFile}`);
        sshConfig.privateKey = fs.readFileSync(identityFile);
      } else {
        // SSH エージェントを使用
        sshConfig.agent = process.env['SSH_AUTH_SOCK'];
        if (!sshConfig.agent) {
          // エージェントがなければデフォルト鍵を試みる
          const defaultKeys = [
            path.join(os.homedir(), '.ssh', 'id_ed25519'),
            path.join(os.homedir(), '.ssh', 'id_rsa'),
            path.join(os.homedir(), '.ssh', 'id_ecdsa'),
          ];
          for (const keyPath of defaultKeys) {
            if (fs.existsSync(keyPath)) {
              logger.debug(`Using default key: ${keyPath}`);
              sshConfig.privateKey = fs.readFileSync(keyPath);
              break;
            }
          }
        }
      }

      logger.debug(`SSH connect: ${username}@${host}:${port}`);
      ssh.connect(sshConfig);
    });
  }

  // -------------------------------------------------------------------------
  // Private: クリーンアップ
  // -------------------------------------------------------------------------

  private _disposeAll(): void {
    for (const [authority, session] of this._sessions) {
      logger.info(`Disposing session: ${authority}`);
      session.dispose();
    }
    this._sessions.clear();
  }
}

// ---------------------------------------------------------------------------
// MoshSession（1 接続分の状態管理）
// ---------------------------------------------------------------------------

interface MoshSessionOpts {
  host: string;
  udpPort: number;
  keyBase64: string;
  mtu: number;
}

/**
 * 1 つの mosh 接続セッションを管理するクラス。
 * `ManagedResolvedAuthority.makeConnection()` から `MoshMessagePassing` を生成する。
 */
class MoshSession {
  private readonly _opts: MoshSessionOpts;
  private _disposed = false;
  private _client: MoshClientWrapper | undefined;

  constructor(opts: MoshSessionOpts) {
    this._opts = opts;
  }

  /**
   * VS Code が接続チャンネルを要求したときに呼ばれる。
   * ManagedMessagePassing 実装を返す。
   */
  async makeConnection(): Promise<vscode.ManagedMessagePassing> {
    if (this._disposed) {
      throw new Error('MoshSession is already disposed');
    }

    logger.info(
      `makeConnection(): ${this._opts.host}:${this._opts.udpPort}`
    );

    // UDP + WASM クライアントを生成
    const client = await MoshClientWrapper.connect({
      host: this._opts.host,
      udpPort: this._opts.udpPort,
      keyBase64: this._opts.keyBase64,
      mtu: this._opts.mtu,
    });
    this._client = client;

    return new MoshMessagePassing(client);
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._client?.end();
    this._client = undefined;
  }
}

// ---------------------------------------------------------------------------
// MoshMessagePassing（vscode.ManagedMessagePassing の実装）
// ---------------------------------------------------------------------------

/**
 * `vscode.ManagedMessagePassing` の実装。
 *
 * VS Code の extension host プロトコル（JSON-RPC ベースのバイナリストリーム）を
 * mosh-wasm + UDP 経由で転送する双方向チャンネル。
 *
 * ## データフロー
 * ```
 * VS Code RPC (send) → MoshClientWrapper.send() → WASM → UDP packets → mosh-server
 * mosh-server → UDP packets → WASM → MoshClientWrapper 'data' event → onDidReceiveMessage
 * ```
 */
class MoshMessagePassing implements vscode.ManagedMessagePassing {
  private readonly _client: MoshClientWrapper;

  // VS Code が購読するイベントエミッター
  private readonly _onDidReceiveMessage: vscode.EventEmitter<Uint8Array>;
  private readonly _onDidClose: vscode.EventEmitter<Error | undefined>;
  private readonly _onDidEnd: vscode.EventEmitter<void>;

  readonly onDidReceiveMessage: vscode.Event<Uint8Array>;
  readonly onDidClose: vscode.Event<Error | undefined>;
  readonly onDidEnd: vscode.Event<void>;

  constructor(client: MoshClientWrapper) {
    this._client = client;

    this._onDidReceiveMessage = new vscode.EventEmitter<Uint8Array>();
    this._onDidClose = new vscode.EventEmitter<Error | undefined>();
    this._onDidEnd = new vscode.EventEmitter<void>();

    this.onDidReceiveMessage = this._onDidReceiveMessage.event;
    this.onDidClose = this._onDidClose.event;
    this.onDidEnd = this._onDidEnd.event;

    // MoshClientWrapper のイベントを VS Code のイベントに変換
    client.on('data', (chunk: Uint8Array) => {
      this._onDidReceiveMessage.fire(chunk);
    });
    client.on('close', (err?: Error) => {
      logger.info('mosh connection closed', err ? `(error: ${err.message})` : '');
      this._onDidClose.fire(err);
      this._dispose();
    });
    client.on('end', () => {
      logger.info('mosh connection ended');
      this._onDidEnd.fire();
      this._dispose();
    });
  }

  /**
   * VS Code RPC データを mosh 経由でサーバーに送信する。
   */
  send(data: Uint8Array): void {
    logger.trace(`MoshMessagePassing.send: ${data.length} bytes`);
    this._client.send(data);
  }

  /**
   * 接続を終了する。
   */
  end(): void {
    logger.info('MoshMessagePassing.end() called');
    this._client.end();
  }

  /**
   * 送信バッファが空になるまで待つ（任意実装）。
   */
  drain(): Thenable<void> {
    return this._client.drain();
  }

  private _dispose(): void {
    this._onDidReceiveMessage.dispose();
    this._onDidClose.dispose();
    this._onDidEnd.dispose();
  }
}
