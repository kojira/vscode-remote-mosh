/**
 * server-installer.ts
 *
 * VS Code Server のリモート自動インストール・起動ロジック。
 *
 * ## フロー
 * 1. SSH 経由でリモートのアーキテクチャを確認 (uname -m)
 * 2. ~/.vscode-server/bin/<commit>/ が存在するか確認
 * 3. なければ curl/wget で VS Code Server をダウンロード・インストール
 * 4. server.sh --start-server --port=0 --connection-token=<token> で起動
 * 5. 起動したサーバーのポート番号をパースして返す
 *
 * ## VS Code Server ダウンロード URL 形式
 * `https://update.code.visualstudio.com/commit:{commit}/server-linux-{arch}/stable`
 *
 * ## server.sh 出力パターン（ポートのパース対象）
 * - "Accepting connections at: 127.0.0.1:<port>"
 * - "Extension host agent listening on <port>"
 * - "Server bound to 127.0.0.1:<port>"
 */
import { Client as SshClient } from 'ssh2';
import * as crypto from 'crypto';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// 公開インターフェース
// ---------------------------------------------------------------------------

/** VS Code Server の接続情報 */
export interface VsCodeServerInfo {
  /** VS Code Server がリッスンしているポート番号 */
  port: number;
  /** 接続トークン */
  connectionToken: string;
  /** サーバーの PID（取得できた場合） */
  pid?: number;
}

/** setupVsCodeServer のオプション */
export interface ServerInstallerOptions {
  /** 接続済みの SSH クライアント */
  sshClient: SshClient;
  /** VS Code のコミットハッシュ（process.env.VSCODE_COMMIT から取得） */
  commit: string;
  /** 接続トークン（省略時はランダム生成） */
  connectionToken?: string;
  /** ダウンロードタイムアウト（ミリ秒、デフォルト: 120000 = 2分） */
  downloadTimeoutMs?: number;
  /** サーバー起動タイムアウト（ミリ秒、デフォルト: 60000 = 1分） */
  startTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// アーキテクチャ検出
// ---------------------------------------------------------------------------

/**
 * リモートマシンのアーキテクチャを検出する。
 *
 * @param sshClient 接続済みの SSH クライアント
 * @returns VS Code Server のアーキテクチャ文字列 ('x64' | 'arm64' | 'armhf')
 */
export async function detectArchitecture(sshClient: SshClient): Promise<string> {
  logger.info('[ServerInstaller] Detecting remote architecture...');
  const output = await execRemote(sshClient, 'uname -m');
  const raw = output.trim();
  logger.info(`[ServerInstaller] Raw architecture: "${raw}"`);

  switch (raw) {
    case 'x86_64':
      return 'x64';
    case 'aarch64':
    case 'arm64':
      return 'arm64';
    case 'armv7l':
    case 'armv6l':
      return 'armhf';
    default:
      logger.warn(`[ServerInstaller] Unknown architecture "${raw}", defaulting to x64`);
      return 'x64';
  }
}

// ---------------------------------------------------------------------------
// インストール確認・インストール
// ---------------------------------------------------------------------------

/**
 * VS Code Server が指定コミット向けにインストール済みかチェックする。
 *
 * @param sshClient 接続済みの SSH クライアント
 * @param commit VS Code コミットハッシュ
 * @returns インストール済みなら true
 */
export async function checkVsCodeServerInstalled(
  sshClient: SshClient,
  commit: string
): Promise<boolean> {
  try {
    const cmd = `test -f "$HOME/.vscode-server/bin/${commit}/server.sh" && echo "exists" || echo "missing"`;
    const result = await execRemote(sshClient, cmd);
    const installed = result.trim() === 'exists';
    logger.info(`[ServerInstaller] VS Code Server (${commit.substring(0, 8)}...) installed: ${installed}`);
    return installed;
  } catch (err) {
    logger.warn('[ServerInstaller] Failed to check VS Code Server installation:', err);
    return false;
  }
}

/**
 * VS Code Server のダウンロード URL を返す。
 *
 * @param commit VS Code コミットハッシュ
 * @param arch アーキテクチャ ('x64' | 'arm64' | 'armhf')
 * @returns ダウンロード URL
 */
export function getVsCodeServerDownloadUrl(commit: string, arch: string): string {
  return `https://update.code.visualstudio.com/commit:${commit}/server-linux-${arch}/stable`;
}

/**
 * VS Code Server をリモートにダウンロード・インストールする。
 *
 * @param sshClient 接続済みの SSH クライアント
 * @param commit VS Code コミットハッシュ
 * @param arch アーキテクチャ文字列
 * @param onProgress 進捗コールバック（省略可能）
 * @param timeoutMs ダウンロードタイムアウト（ミリ秒）
 */
export async function installVsCodeServer(
  sshClient: SshClient,
  commit: string,
  arch: string,
  onProgress?: (msg: string) => void,
  timeoutMs = 120_000
): Promise<void> {
  const downloadUrl = getVsCodeServerDownloadUrl(commit, arch);
  const installDir = `~/.vscode-server/bin/${commit}`;
  const tarFile = `/tmp/vscode-server-${commit.substring(0, 8)}-${arch}.tar.gz`;

  logger.info(`[ServerInstaller] Downloading VS Code Server from: ${downloadUrl}`);
  onProgress?.(`Downloading VS Code Server (linux-${arch})...`);

  // curl または wget でダウンロード → tar 展開 → server.sh を実行可能に
  const script = `
set -e
mkdir -p "${installDir}"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL --retry 3 --retry-delay 5 "${downloadUrl}" -o "${tarFile}"
elif command -v wget >/dev/null 2>&1; then
  wget -q --tries=3 --waitretry=5 "${downloadUrl}" -O "${tarFile}"
else
  echo "ERROR: Neither curl nor wget is available on remote host" >&2
  exit 1
fi
echo "Download complete, extracting..."
tar -xzf "${tarFile}" -C ~/.vscode-server/bin/ --strip-components=1 --one-top-level="${commit}"
rm -f "${tarFile}"
chmod +x "${installDir}/server.sh"
echo "VS Code Server installed: ${installDir}"
`.trim();

  const output = await execRemote(sshClient, script, timeoutMs);
  logger.info('[ServerInstaller] Installation output:', output.trim());
  onProgress?.('VS Code Server installed successfully.');
}

// ---------------------------------------------------------------------------
// VS Code Server 起動
// ---------------------------------------------------------------------------

/**
 * VS Code Server を SSH 経由で起動し、リッスンポートを返す。
 *
 * @param sshClient 接続済みの SSH クライアント
 * @param commit VS Code コミットハッシュ
 * @param connectionToken 接続トークン
 * @param onProgress 進捗コールバック（省略可能）
 * @param timeoutMs 起動タイムアウト（ミリ秒）
 * @returns VS Code Server の接続情報
 */
export async function startVsCodeServer(
  sshClient: SshClient,
  commit: string,
  connectionToken: string,
  onProgress?: (msg: string) => void,
  timeoutMs = 60_000
): Promise<VsCodeServerInfo> {
  const serverScript = `$HOME/.vscode-server/bin/${commit}/server.sh`;

  logger.info(`[ServerInstaller] Starting VS Code Server (commit: ${commit.substring(0, 8)}...)`);
  onProgress?.('Starting VS Code Server...');

  // server.sh コマンド
  // --port=0: ランダムポートを使用（実際のポートを stdout から取得）
  // --host=127.0.0.1: ローカルホストのみでリッスン（mosh/SSH トンネル経由でアクセス）
  // --connection-token: セキュリティトークン
  const startCmd = [
    serverScript,
    '--start-server',
    '--port=0',
    `--connection-token=${connectionToken}`,
    '--host=127.0.0.1',
    '--without-browser-env-var',
    '--disable-telemetry',
    '--accept-server-license-terms',
  ].join(' ');

  logger.debug(`[ServerInstaller] Server command: ${startCmd}`);

  return new Promise<VsCodeServerInfo>((resolve, reject) => {
    let output = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error(
          `VS Code Server did not start within ${timeoutMs}ms.\n` +
          `Output so far: ${output.trim().substring(0, 1000)}`
        ));
      }
    }, timeoutMs);

    const tryParse = (): boolean => {
      const port = parseVsCodeServerPort(output);
      if (port !== null && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        logger.info(`[ServerInstaller] VS Code Server listening on port ${port}`);
        onProgress?.(`VS Code Server started on port ${port}`);
        resolve({ port, connectionToken });
        return true;
      }
      return false;
    };

    sshClient.exec(startCmd, { pty: false }, (err, stream) => {
      if (err) {
        clearTimeout(timeout);
        reject(new Error(`Failed to exec VS Code Server: ${err.message}`));
        return;
      }

      stream.on('data', (data: Buffer) => {
        const text = data.toString('utf8');
        output += text;
        logger.debug(`[ServerInstaller] vscode-server stdout: ${text.trim()}`);
        tryParse();
      });

      stream.stderr.on('data', (data: Buffer) => {
        const text = data.toString('utf8');
        output += text;
        logger.debug(`[ServerInstaller] vscode-server stderr: ${text.trim()}`);
        tryParse();
      });

      stream.on('close', (code: number | null) => {
        if (!resolved) {
          clearTimeout(timeout);
          reject(new Error(
            `VS Code Server process exited with code ${code} before starting.\n` +
            `Output: ${output.trim().substring(0, 2000)}`
          ));
        }
      });
    });
  });
}

// ---------------------------------------------------------------------------
// メイン: 完全セットアップ
// ---------------------------------------------------------------------------

/**
 * VS Code Server のフルセットアップ（検出 → インストール → 起動）を行う。
 *
 * 手順:
 * 1. リモートアーキテクチャを確認
 * 2. VS Code Server インストール状況を確認
 * 3. 未インストールならダウンロード・インストール
 * 4. VS Code Server を起動
 * 5. リッスンポートと接続トークンを返す
 *
 * @param opts セットアップオプション
 * @param onProgress 進捗コールバック（省略可能）
 * @returns VS Code Server の接続情報
 */
export async function setupVsCodeServer(
  opts: ServerInstallerOptions,
  onProgress?: (msg: string) => void
): Promise<VsCodeServerInfo> {
  const { sshClient, commit } = opts;
  const connectionToken = opts.connectionToken ?? crypto.randomBytes(20).toString('hex');
  const downloadTimeoutMs = opts.downloadTimeoutMs ?? 120_000;
  const startTimeoutMs = opts.startTimeoutMs ?? 60_000;

  logger.info(`[ServerInstaller] === VS Code Server Setup (commit: ${commit.substring(0, 8)}...) ===`);

  // Step 1: アーキテクチャ確認
  onProgress?.('Detecting remote architecture...');
  const arch = await detectArchitecture(sshClient);
  logger.info(`[ServerInstaller] Arch: ${arch}`);

  // Step 2: インストール確認
  onProgress?.('Checking VS Code Server installation...');
  const isInstalled = await checkVsCodeServerInstalled(sshClient, commit);

  // Step 3: インストール（必要な場合のみ）
  if (!isInstalled) {
    logger.info('[ServerInstaller] VS Code Server not found, installing...');
    onProgress?.(`Installing VS Code Server (linux-${arch})...`);
    await installVsCodeServer(sshClient, commit, arch, onProgress, downloadTimeoutMs);
  } else {
    logger.info('[ServerInstaller] VS Code Server already installed, skipping download.');
    onProgress?.('VS Code Server already installed.');
  }

  // Step 4: 起動
  onProgress?.('Starting VS Code Server...');
  const serverInfo = await startVsCodeServer(
    sshClient,
    commit,
    connectionToken,
    onProgress,
    startTimeoutMs
  );

  logger.info(
    `[ServerInstaller] === Setup complete: port=${serverInfo.port}, ` +
    `token=${serverInfo.connectionToken.substring(0, 8)}... ===`
  );

  return serverInfo;
}

// ---------------------------------------------------------------------------
// ユーティリティ関数
// ---------------------------------------------------------------------------

/**
 * SSH 経由でコマンドを実行し、stdout 全体を文字列で返す。
 *
 * コマンドが非ゼロ終了コードで終了した場合はエラーをスローする。
 *
 * @param sshClient 接続済みの SSH クライアント
 * @param command 実行するシェルコマンド
 * @param timeoutMs タイムアウト（ミリ秒、デフォルト: 30000）
 * @returns stdout の内容
 */
export async function execRemote(
  sshClient: SshClient,
  command: string,
  timeoutMs = 30_000
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error(
          `Remote command timed out after ${timeoutMs}ms: "${command.substring(0, 100)}"`
        ));
      }
    }, timeoutMs);

    sshClient.exec(command, { pty: false }, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        reject(new Error(`exec error: ${err.message}`));
        return;
      }

      stream.on('data', (data: Buffer) => {
        stdout += data.toString('utf8');
      });

      stream.stderr.on('data', (data: Buffer) => {
        stderr += data.toString('utf8');
      });

      stream.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (done) {
          return;
        }
        done = true;
        if (code !== null && code !== 0) {
          reject(new Error(
            `Remote command exited with code ${code}: "${command.substring(0, 100)}"\n` +
            `stderr: ${stderr.trim().substring(0, 500)}`
          ));
        } else {
          resolve(stdout);
        }
      });
    });
  });
}

/**
 * "MOSH CONNECT <port> <key>" 形式の文字列をパースする。
 *
 * mosh-server は起動時に以下の形式を stdout に出力する:
 * `\r\nMOSH CONNECT <udpPort> <base64key>\r\n`
 *
 * @param output mosh-server の stdout
 * @returns パース成功時は { udpPort, key }、失敗時は null
 */
export function parseMoshConnect(output: string): { udpPort: number; key: string } | null {
  const match = output.match(/MOSH CONNECT (\d+) ([A-Za-z0-9+/=]{22,})/);
  if (!match) {
    return null;
  }
  const udpPort = parseInt(match[1], 10);
  const key = match[2];

  if (isNaN(udpPort) || udpPort <= 0 || udpPort > 65535) {
    logger.warn(`[parseMoshConnect] Invalid UDP port: ${match[1]}`);
    return null;
  }

  return { udpPort, key };
}

/**
 * VS Code Server の起動ログからポート番号をパースする。
 *
 * 対応する出力パターン:
 * - "Accepting connections at: 127.0.0.1:12345"
 * - "Accepting connections at: 12345"
 * - "Extension host agent listening on 12345"
 * - "Server bound to 127.0.0.1:12345"
 * - "listening on 12345"
 *
 * @param output VS Code Server の stdout/stderr（累積文字列）
 * @returns ポート番号（数値）、見つからない場合は null
 */
export function parseVsCodeServerPort(output: string): number | null {
  const patterns = [
    /Accepting connections at[^:]*:\s*(?:127\.0\.0\.1:)?(\d+)/i,
    /Extension host agent listening on (\d+)/i,
    /Server bound to (?:127\.0\.0\.1:)?(\d+)/i,
    /listening on (?:127\.0\.0\.1:)?(\d+)/i,
    /started on port (\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) {
      const port = parseInt(match[1], 10);
      if (!isNaN(port) && port > 0 && port < 65536) {
        return port;
      }
    }
  }

  return null;
}

/**
 * VS Code のコミットハッシュを取得する。
 *
 * 取得順序:
 * 1. `process.env.VSCODE_COMMIT` 環境変数（extension host が自動設定）
 * 2. `VSCODE_PID` から実行中の VS Code 情報を取得（フォールバック）
 *
 * @returns コミットハッシュ文字列（取得できない場合は空文字列）
 */
export function getVsCodeCommit(): string {
  // VS Code extension host は VSCODE_COMMIT を設定する
  const envCommit = process.env['VSCODE_COMMIT'];
  if (envCommit) {
    logger.debug(`[ServerInstaller] Got commit from VSCODE_COMMIT: ${envCommit.substring(0, 8)}...`);
    return envCommit;
  }

  // フォールバック: VSCODE_IPC_HOOK などから推測可能だが、
  // 実環境では通常 VSCODE_COMMIT が設定されているはず
  logger.warn('[ServerInstaller] VSCODE_COMMIT not set, VS Code Server version may mismatch');
  return '';
}
