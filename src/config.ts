/**
 * config.ts
 *
 * VS Code の設定 (`remoteMosh.*`) を型安全に読み出すヘルパー。
 */
import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

/** 拡張機能の設定をまとめた型 */
export interface MoshConfig {
  /** SSH デフォルトユーザー名。空文字の場合は OS ユーザー名を使う */
  defaultUser: string;
  /** mosh の優先 UDP ポート（デフォルト: 60001） */
  defaultPort: number;
  /** SSH 秘密鍵ファイルのパス。空文字の場合はエージェント or デフォルト鍵 */
  identityFile: string;
  /** リモートの mosh-server バイナリパス */
  serverPath: string;
  /** UDP MTU（バイト） */
  mtu: number;
  /** ログレベル */
  logLevel: string;
}

/** 設定を読み込んで返す */
export function getMoshConfig(): MoshConfig {
  const cfg = vscode.workspace.getConfiguration('remoteMosh');
  const rawUser = cfg.get<string>('defaultUser', '');
  return {
    defaultUser: rawUser || os.userInfo().username,
    defaultPort: cfg.get<number>('defaultPort', 60001),
    identityFile: resolveHome(cfg.get<string>('identityFile', '')),
    serverPath: cfg.get<string>('serverPath', 'mosh-server'),
    mtu: cfg.get<number>('mtu', 500),
    logLevel: cfg.get<string>('logLevel', 'info'),
  };
}

/**
 * authority 文字列をパースして接続パラメータを返す。
 *
 * authority の形式:
 *   `mosh+user@hostname`
 *   `mosh+user@hostname:sshPort`
 *   `mosh+hostname`
 *
 * @example
 *   parseAuthority('user@example.com:22') → { user: 'user', host: 'example.com', sshPort: 22 }
 *   parseAuthority('example.com')         → { user: undefined, host: 'example.com', sshPort: 22 }
 */
export function parseAuthority(authority: string): {
  user: string | undefined;
  host: string;
  sshPort: number;
} {
  // authority は "mosh+<rest>" の形で来るので "mosh+" プレフィックスを除去
  const rest = authority.replace(/^mosh\+/, '');

  let user: string | undefined;
  let hostWithPort: string;

  if (rest.includes('@')) {
    const atIdx = rest.lastIndexOf('@');
    user = rest.substring(0, atIdx);
    hostWithPort = rest.substring(atIdx + 1);
  } else {
    hostWithPort = rest;
  }

  let host: string;
  let sshPort = 22;

  if (hostWithPort.includes(':')) {
    const colonIdx = hostWithPort.lastIndexOf(':');
    host = hostWithPort.substring(0, colonIdx);
    sshPort = parseInt(hostWithPort.substring(colonIdx + 1), 10) || 22;
  } else {
    host = hostWithPort;
  }

  return { user, host, sshPort };
}

/** `~/` をホームディレクトリに展開する */
function resolveHome(p: string): string {
  if (!p) {
    return p;
  }
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}
