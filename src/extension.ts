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
 *               ├─ [Step 1] SSH 接続
 *               ├─ [Step 2] mosh-server 起動（UDPトランスポート確立）
 *               │              "MOSH CONNECT <port> <key>" をパース
 *               ├─ [Step 3] VS Code Server 自動インストール・起動（SSH経由）
 *               │              ~/.vscode-server/bin/<commit>/server.sh
 *               └─ [Step 4] ManagedResolvedAuthority 返却
 *                             makeConnection() → MoshMessagePassing
 *                                   → MoshClientWrapper（UDP + WASM）
 * ```
 *
 * ## 接続シーケンス詳細
 *
 * 1. SSH でリモートに接続
 * 2. SSH 経由で `mosh-server new -s -p <port>` を起動
 *    → "MOSH CONNECT <udpPort> <key>" を取得
 * 3. VS Code Server のセットアップ（インストール + 起動）
 *    → アーキテクチャ確認 → curl でダウンロード → server.sh --start-server --port=0
 *    → リッスンポートと接続トークンを取得
 * 4. ManagedResolvedAuthority を VS Code に返す
 *    → makeConnection() が呼ばれたら MoshClientWrapper（WASM + UDP）を使って接続
 */
import * as vscode from 'vscode';
import { initLogger, logger } from './logger';
import { getMoshConfig, parseAuthority } from './config';
import { MoshClientWrapper } from './mosh-client';
import {
  setupVsCodeServer,
  parseMoshConnect,
  getVsCodeCommit,
  type VsCodeServerInfo,
} from './server-installer';

// SSH クライアント
import { Client as SshClient, ConnectConfig } from 'ssh2';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Extension Lifecycle
// ---------------------------------------------------------------------------

/** アクティブな接続のステータスバーアイテム */
let _statusBarItem: vscode.StatusBarItem | undefined;

/** 現在の接続ホスト */
let _connectedHost: string | undefined;

/**
 * ステータスバーアイテムを更新する。
 * @param state 'connecting' | 'connected' | 'disconnected'
 * @param host 接続先ホスト名
 */
function updateStatusBar(
  state: 'connecting' | 'connected' | 'disconnected',
  host?: string
): void {
  if (!_statusBarItem) {
    return;
  }
  switch (state) {
    case 'connecting':
      _statusBarItem.text = `$(loading~spin) Mosh: Connecting to ${host ?? '...'}`;
      _statusBarItem.tooltip = `Connecting to ${host ?? 'remote host'} via Mosh`;
      _statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      _statusBarItem.show();
      break;
    case 'connected':
      _statusBarItem.text = `$(remote) Mosh: ${host ?? 'Connected'}`;
      _statusBarItem.tooltip = `Connected to ${host ?? 'remote host'} via Mosh\nClick to show log`;
      _statusBarItem.backgroundColor = undefined;
      _statusBarItem.show();
      break;
    case 'disconnected':
      _statusBarItem.text = `$(remote) Mosh`;
      _statusBarItem.tooltip = 'Remote - Mosh: Not connected';
      _statusBarItem.backgroundColor = undefined;
      _statusBarItem.hide();
      break;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  initLogger(context);
  logger.info('Remote-Mosh extension activating...');
  logger.info(`VS Code version: ${vscode.version}`);
  logger.info(`VS Code commit: ${process.env['VSCODE_COMMIT'] ?? '(unknown)'}`);

  // ステータスバーアイテムを作成（左側に表示）
  _statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  _statusBarItem.command = 'remoteMosh.showLog';
  context.subscriptions.push(_statusBarItem);

  // RemoteAuthorityResolver を登録
  const resolver = new MoshRemoteAuthorityResolver(context);
  context.subscriptions.push(
    (vscode.workspace as typeof vscode.workspace).registerRemoteAuthorityResolver('mosh', resolver)
  );

  // コマンド: 出力チャンネルを開く
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteMosh.showLog', () => {
      logger.info('User opened Remote-Mosh log');
      logger.show();
    })
  );

  // コマンド: Mosh ホストに接続
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteMosh.connect', async () => {
      await _cmdConnect();
    })
  );

  // コマンド: 現在の Mosh 接続を切断
  context.subscriptions.push(
    vscode.commands.registerCommand('remoteMosh.disconnect', async () => {
      await _cmdDisconnect();
    })
  );

  // リモートセッション中のステータスバー表示
  if (vscode.env.remoteName === 'mosh') {
    _connectedHost = vscode.env.remoteAuthority?.replace(/^mosh\+/, '') ?? 'remote';
    updateStatusBar('connected', _connectedHost);
    logger.info(`Already in mosh session: ${_connectedHost}`);
  }

  logger.info('Remote-Mosh extension activated. Authority prefix: mosh');
}

export function deactivate(): void {
  logger.info('Remote-Mosh extension deactivating...');
  _statusBarItem?.dispose();
  _statusBarItem = undefined;
}

// ---------------------------------------------------------------------------
// Connect コマンド実装（QuickPick UI）
// ---------------------------------------------------------------------------

/**
 * 接続先ホストを QuickPick で選択し、VS Code リモートウィンドウを開く。
 *
 * 入力形式（QuickPick で受付）:
 *   - `hostname`
 *   - `user@hostname`
 *   - `user@hostname:port`
 */
async function _cmdConnect(): Promise<void> {
  const config = getMoshConfig();

  const hostInput = await vscode.window.showInputBox({
    title: 'Remote - Mosh: Connect to Host',
    prompt: 'Enter hostname (user@host, user@host:port, or host)',
    placeHolder: `e.g. ${config.defaultUser}@example.com`,
    validateInput: (val) => {
      if (!val || val.trim().length === 0) {
        return 'Hostname is required';
      }
      const trimmed = val.trim();
      const hostPart = trimmed.includes('@') ? trimmed.split('@').pop() : trimmed;
      if (!hostPart || hostPart.replace(/:\d+$/, '').trim().length === 0) {
        return 'Invalid hostname format';
      }
      return undefined;
    },
  });

  if (!hostInput) {
    return;
  }

  const trimmedHost = hostInput.trim();

  const folderPath = await vscode.window.showInputBox({
    title: 'Remote - Mosh: Remote Folder',
    prompt: 'Enter the remote folder path to open',
    placeHolder: '/home/' + config.defaultUser,
    value: '/home/' + (
      trimmedHost.includes('@') ? trimmedHost.split('@')[0] : config.defaultUser
    ),
  });

  if (folderPath === undefined) {
    return;
  }

  const remotePath = folderPath.trim() || '/';
  const authority = `mosh+${trimmedHost}`;
  const uri = vscode.Uri.parse(`vscode-remote://${authority}${remotePath}`);

  logger.info(`Opening remote folder: ${uri.toString()}`);
  updateStatusBar('connecting', trimmedHost);

  try {
    await vscode.commands.executeCommand('vscode.openFolder', uri, {
      forceNewWindow: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to open remote folder:', message);
    vscode.window.showErrorMessage(
      `Remote - Mosh: Failed to connect to ${trimmedHost}: ${message}\n` +
      'Check the Remote-Mosh log for details (Ctrl+Shift+P → "Remote-Mosh: Show Log").'
    );
    updateStatusBar('disconnected');
  }
}

/**
 * 現在の Mosh 接続を切断してローカルウィンドウに戻る。
 */
async function _cmdDisconnect(): Promise<void> {
  const answer = await vscode.window.showWarningMessage(
    `Disconnect from ${_connectedHost ?? 'remote host'} via Mosh?`,
    { modal: true },
    'Disconnect'
  );
  if (answer === 'Disconnect') {
    logger.info('User requested disconnect from mosh session');
    updateStatusBar('disconnected');
    await vscode.commands.executeCommand('workbench.action.remote.close');
  }
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
    logger.info('════════════════════════════════════════');
    logger.info(`resolve() called: authority="${authority}"`);
    logger.info(`resolve attempt: ${context.resolveAttempt}`);
    logger.info('════════════════════════════════════════');

    const config = getMoshConfig();
    const { user, host, sshPort } = parseAuthority(authority);
    const sshUser = user || config.defaultUser;

    logger.info(`[resolve] Target: ${sshUser}@${host}:${sshPort}`);
    logger.info(`[resolve] Mosh preferred port: ${config.defaultPort}`);
    logger.info(`[resolve] mosh-server path: ${config.serverPath}`);

    // 再接続の場合は既存セッションをクリーンアップ
    if (context.resolveAttempt > 0) {
      logger.info(`[resolve] Re-connecting (attempt ${context.resolveAttempt}), cleaning up old session...`);
      const existing = this._sessions.get(authority);
      if (existing) {
        existing.dispose();
        this._sessions.delete(authority);
      }
    }

    // VS Code コミットハッシュを取得
    const vsCodeCommit = getVsCodeCommit();
    if (!vsCodeCommit) {
      logger.warn('[resolve] VS Code commit hash not available, VS Code Server version may mismatch');
    }

    let session: MoshSession | undefined;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Remote-Mosh: Connecting to ${sshUser}@${host}`,
        cancellable: false,
      },
      async (progress) => {
        // ────────────────────────────────────────────────
        // Step 1: SSH 接続
        // ────────────────────────────────────────────────
        progress.report({ message: '[1/4] Establishing SSH connection...' });
        logger.info(`[Step 1/4] Connecting via SSH: ${sshUser}@${host}:${sshPort}`);

        const sshClient = await this._createSshClient({
          host,
          port: sshPort,
          username: sshUser,
          identityFile: config.identityFile,
        });

        logger.info('[Step 1/4] SSH connection established ✓');

        try {
          // ────────────────────────────────────────────────
          // Step 2: mosh-server 起動
          // ────────────────────────────────────────────────
          progress.report({ message: '[2/4] Starting mosh-server...' });
          logger.info(`[Step 2/4] Starting mosh-server on ${host}...`);

          const moshInfo = await this._startMoshServer(sshClient, {
            moshServerPath: config.serverPath,
            preferredUdpPort: config.defaultPort,
          });

          logger.info(`[Step 2/4] mosh-server started ✓ UDP port=${moshInfo.udpPort}`);

          // ────────────────────────────────────────────────
          // Step 3: VS Code Server セットアップ
          // ────────────────────────────────────────────────
          progress.report({ message: '[3/4] Setting up VS Code Server...' });
          logger.info(`[Step 3/4] Setting up VS Code Server on ${host}...`);

          let vsServerInfo: VsCodeServerInfo | undefined;

          if (vsCodeCommit) {
            try {
              vsServerInfo = await setupVsCodeServer(
                {
                  sshClient,
                  commit: vsCodeCommit,
                  downloadTimeoutMs: 120_000,
                  startTimeoutMs: 60_000,
                },
                (msg) => {
                  progress.report({ message: `[3/4] ${msg}` });
                  logger.info(`[Step 3/4] ${msg}`);
                }
              );
              logger.info(
                `[Step 3/4] VS Code Server ready ✓ port=${vsServerInfo.port}`
              );
            } catch (serverErr) {
              logger.error('[Step 3/4] VS Code Server setup failed:', serverErr);
              logger.warn('[Step 3/4] Continuing without VS Code Server (degraded mode)');
              progress.report({ message: '[3/4] VS Code Server setup failed, continuing...' });
            }
          } else {
            logger.warn('[Step 3/4] Skipping VS Code Server setup (no commit hash)');
            progress.report({ message: '[3/4] Skipping VS Code Server setup...' });
          }

          // ────────────────────────────────────────────────
          // Step 4: セッション情報を保存
          // ────────────────────────────────────────────────
          progress.report({ message: '[4/4] Establishing mosh connection...' });
          logger.info(`[Step 4/4] Creating MoshSession for ${host}:${moshInfo.udpPort}`);

          session = new MoshSession({
            host,
            udpPort: moshInfo.udpPort,
            keyBase64: moshInfo.key,
            mtu: config.mtu,
            vsCodeServerInfo: vsServerInfo,
          });

          this._sessions.set(authority, session);
          logger.info('[Step 4/4] MoshSession created ✓');

        } finally {
          // SSH 接続はここで終了（mosh は別の UDP チャンネルを使う）
          sshClient.end();
          logger.info('[resolve] SSH connection closed');
        }
      }
    );

    const finalSession = this._sessions.get(authority);
    if (!finalSession) {
      const errMsg = 'Failed to establish mosh connection. Check the Remote-Mosh log for details.';
      logger.error(`[resolve] ${errMsg}`);
      throw vscode.RemoteAuthorityResolverError.TemporarilyNotAvailable(errMsg);
    }

    const connectionToken = crypto.randomUUID();
    logger.info(`[resolve] Returning ManagedResolvedAuthority (token: ${connectionToken.substring(0, 8)}...)`);

    updateStatusBar('connected', host);

    return new vscode.ManagedResolvedAuthority(
      () => finalSession.makeConnection(),
      connectionToken
    );
  }

  // -------------------------------------------------------------------------
  // Private: SSH クライアント作成
  // -------------------------------------------------------------------------

  /**
   * SSH 接続を確立して SshClient を返す。
   */
  private async _createSshClient(opts: {
    host: string;
    port: number;
    username: string;
    identityFile: string;
  }): Promise<SshClient> {
    const { host, port, username, identityFile } = opts;

    return new Promise<SshClient>((resolve, reject) => {
      const ssh = new SshClient();
      let connected = false;

      const cleanup = (err: Error): void => {
        if (!connected) {
          connected = true;
          ssh.end();
          reject(err);
        }
      };

      ssh.on('ready', () => {
        connected = true;
        logger.debug(`[SSH] Ready: ${username}@${host}:${port}`);
        resolve(ssh);
      });

      ssh.on('error', (err: Error) => {
        logger.error(`[SSH] Connection error: ${err.message}`);
        const userFriendlyMsg = _makeSshErrorMessage(err, host, port, username);
        cleanup(new Error(userFriendlyMsg));
      });

      ssh.on('close', () => {
        if (!connected) {
          cleanup(new Error(`SSH connection to ${host}:${port} closed before ready`));
        }
      });

      // SSH 接続設定
      const sshConfig: ConnectConfig = {
        host,
        port,
        username,
        readyTimeout: 20_000,  // 20秒でタイムアウト
        keepaliveInterval: 10_000,
        keepaliveCountMax: 3,
      };

      // 秘密鍵の設定
      if (identityFile && fs.existsSync(identityFile)) {
        logger.debug(`[SSH] Using identity file: ${identityFile}`);
        try {
          sshConfig.privateKey = fs.readFileSync(identityFile);
        } catch (readErr) {
          logger.warn(`[SSH] Failed to read identity file: ${identityFile}`, readErr);
        }
      }

      if (!sshConfig.privateKey) {
        // SSH エージェントを試みる
        const agentSock = process.env['SSH_AUTH_SOCK'];
        if (agentSock) {
          logger.debug(`[SSH] Using SSH agent: ${agentSock}`);
          sshConfig.agent = agentSock;
        } else {
          // デフォルト鍵ファイルを探す
          const defaultKeys = [
            path.join(os.homedir(), '.ssh', 'id_ed25519'),
            path.join(os.homedir(), '.ssh', 'id_ecdsa'),
            path.join(os.homedir(), '.ssh', 'id_rsa'),
          ];
          for (const keyPath of defaultKeys) {
            if (fs.existsSync(keyPath)) {
              logger.debug(`[SSH] Using default key: ${keyPath}`);
              try {
                sshConfig.privateKey = fs.readFileSync(keyPath);
                break;
              } catch {
                // 次のキーを試す
              }
            }
          }

          if (!sshConfig.privateKey) {
            logger.warn('[SSH] No SSH key found. Connection may fail without password auth.');
          }
        }
      }

      logger.debug(`[SSH] Connecting: ${username}@${host}:${port}`);
      ssh.connect(sshConfig);
    });
  }

  // -------------------------------------------------------------------------
  // Private: mosh-server 起動
  // -------------------------------------------------------------------------

  /**
   * SSH 経由で mosh-server を起動し、UDP ポートと鍵を返す。
   *
   * @param sshClient 接続済みの SSH クライアント
   * @param opts mosh-server オプション
   * @returns UDP ポートと AES-128 鍵（Base64）
   */
  private async _startMoshServer(
    sshClient: SshClient,
    opts: {
      moshServerPath: string;
      preferredUdpPort: number;
    }
  ): Promise<{ udpPort: number; key: string }> {
    const { moshServerPath, preferredUdpPort } = opts;

    return new Promise<{ udpPort: number; key: string }>((resolve, reject) => {
      let output = '';
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(
            'mosh-server did not output "MOSH CONNECT" within 30s.\n' +
            'Make sure mosh-server is installed on the remote host.\n' +
            `Output: ${output.trim().substring(0, 500)}`
          ));
        }
      }, 30_000);

      // mosh-server 起動コマンド
      // -s: stdout に "MOSH CONNECT ..." を出力するモード
      // -p: 優先 UDP ポート
      // --: 以降はリモートシェルへの引数
      const moshCmd = [
        moshServerPath,
        'new',
        '-s',
        '-p', String(preferredUdpPort),
        '--',
        '/bin/bash',
      ].join(' ');

      logger.debug(`[mosh-server] Command: ${moshCmd}`);

      sshClient.exec(moshCmd, { pty: false }, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          reject(new Error(`Failed to start mosh-server: ${err.message}`));
          return;
        }

        stream.on('data', (data: Buffer) => {
          const text = data.toString('utf8');
          output += text;
          logger.trace(`[mosh-server] stdout: ${text.trim()}`);

          const parsed = parseMoshConnect(output);
          if (parsed && !resolved) {
            resolved = true;
            clearTimeout(timeout);
            logger.info(`[mosh-server] Connected: UDP port=${parsed.udpPort}`);
            resolve(parsed);
          }
        });

        stream.stderr.on('data', (data: Buffer) => {
          const text = data.toString('utf8');
          logger.debug(`[mosh-server] stderr: ${text.trim()}`);
        });

        stream.on('close', (code: number | null) => {
          if (!resolved) {
            clearTimeout(timeout);
            reject(new Error(
              `mosh-server exited with code ${code} without outputting "MOSH CONNECT".\n` +
              'Possible causes:\n' +
              `  1. mosh-server not installed at: ${moshServerPath}\n` +
              '  2. UDP port range blocked by firewall (60001-61000)\n' +
              '  3. mosh-server version mismatch\n' +
              `Output: ${output.trim().substring(0, 1000)}`
            ));
          }
        });
      });
    });
  }

  // -------------------------------------------------------------------------
  // Private: クリーンアップ
  // -------------------------------------------------------------------------

  private _disposeAll(): void {
    for (const [authority, session] of this._sessions) {
      logger.info(`[resolve] Disposing session: ${authority}`);
      session.dispose();
    }
    this._sessions.clear();
    logger.info('[resolve] All sessions disposed');
  }
}

// ---------------------------------------------------------------------------
// SSH エラーメッセージのヒューマナイズ
// ---------------------------------------------------------------------------

/**
 * SSH エラーをユーザーフレンドリーなメッセージに変換する。
 */
function _makeSshErrorMessage(err: Error, host: string, port: number, username: string): string {
  const msg = err.message.toLowerCase();

  if (msg.includes('timeout') || msg.includes('timed out')) {
    return (
      `SSH connection to ${host}:${port} timed out.\n` +
      'Possible causes:\n' +
      '  1. Host is unreachable (check network / firewall)\n' +
      `  2. SSH port ${port} is not open on the remote host\n` +
      '  3. Connection is very slow (try increasing timeout in settings)'
    );
  }

  if (msg.includes('authentication') || msg.includes('auth')) {
    return (
      `SSH authentication failed for ${username}@${host}.\n` +
      'Possible causes:\n' +
      '  1. SSH key not in authorized_keys on remote host\n' +
      '  2. SSH agent not running (start with: eval $(ssh-agent) && ssh-add)\n' +
      '  3. Wrong username or key file in settings\n' +
      'Tip: Set "remoteMosh.identityFile" in VS Code settings to specify the key.'
    );
  }

  if (msg.includes('refused') || msg.includes('econnrefused')) {
    return (
      `SSH connection refused by ${host}:${port}.\n` +
      'Possible causes:\n' +
      `  1. SSH server not running on ${host}\n` +
      `  2. Wrong SSH port (currently: ${port})\n` +
      '  3. Firewall is blocking the connection'
    );
  }

  if (msg.includes('no such host') || msg.includes('enotfound')) {
    return (
      `Cannot resolve hostname: ${host}.\n` +
      'Check that the hostname is correct and DNS is working.'
    );
  }

  return `SSH connection to ${username}@${host}:${port} failed: ${err.message}`;
}

// ---------------------------------------------------------------------------
// MoshSession（1 接続分の状態管理）
// ---------------------------------------------------------------------------

interface MoshSessionOpts {
  host: string;
  udpPort: number;
  keyBase64: string;
  mtu: number;
  vsCodeServerInfo?: VsCodeServerInfo;
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

    if (opts.vsCodeServerInfo) {
      logger.info(
        `[MoshSession] VS Code Server: localhost:${opts.vsCodeServerInfo.port} ` +
        `(token: ${opts.vsCodeServerInfo.connectionToken.substring(0, 8)}...)`
      );
    } else {
      logger.warn('[MoshSession] No VS Code Server info available');
    }
  }

  /**
   * VS Code が接続チャンネルを要求したときに呼ばれる。
   * ManagedMessagePassing 実装を返す。
   */
  async makeConnection(): Promise<vscode.ManagedMessagePassing> {
    if (this._disposed) {
      throw new Error('MoshSession has been disposed');
    }

    logger.info(`[MoshSession] makeConnection(): ${this._opts.host}:${this._opts.udpPort}`);

    try {
      const client = await MoshClientWrapper.connect({
        host: this._opts.host,
        udpPort: this._opts.udpPort,
        keyBase64: this._opts.keyBase64,
        mtu: this._opts.mtu,
      });
      this._client = client;
      logger.info('[MoshSession] MoshClientWrapper connected ✓');

      return new MoshMessagePassing(client);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('[MoshSession] makeConnection() failed:', errMsg);
      throw new Error(
        `Failed to establish mosh connection to ${this._opts.host}:${this._opts.udpPort}: ${errMsg}\n` +
        'Make sure mosh-server is running and UDP port is accessible.'
      );
    }
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    logger.info('[MoshSession] Disposing...');
    this._client?.end();
    this._client = undefined;
    logger.info('[MoshSession] Disposed');
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

  private _disposed = false;

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
      logger.trace(`[MoshMessagePassing] Received: ${chunk.length} bytes → VS Code`);
      this._onDidReceiveMessage.fire(chunk);
    });

    client.on('close', (err?: Error) => {
      const reason = err ? `error: ${err.message}` : 'clean';
      logger.info(`[MoshMessagePassing] Connection closed (${reason})`);
      this._onDidClose.fire(err);
      this._disposeEmitters();
    });

    client.on('end', () => {
      logger.info('[MoshMessagePassing] Connection ended (FIN received)');
      this._onDidEnd.fire();
      this._disposeEmitters();
    });

    logger.info('[MoshMessagePassing] Created and event listeners attached');
  }

  /**
   * VS Code RPC データを mosh 経由でサーバーに送信する。
   */
  send(data: Uint8Array): void {
    logger.trace(`[MoshMessagePassing] send: ${data.length} bytes → mosh`);
    this._client.send(data);
  }

  /**
   * 接続を終了する。
   */
  end(): void {
    logger.info('[MoshMessagePassing] end() called');
    this._client.end();
  }

  /**
   * 送信バッファが空になるまで待つ。
   */
  drain(): Thenable<void> {
    return this._client.drain();
  }

  private _disposeEmitters(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this._onDidReceiveMessage.dispose();
    this._onDidClose.dispose();
    this._onDidEnd.dispose();
  }
}
