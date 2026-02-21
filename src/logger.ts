/**
 * logger.ts
 *
 * VS Code OutputChannel ベースのロガー。
 * ログレベルは設定 `remoteMosh.logLevel` で制御する。
 */
import * as vscode from 'vscode';

/** ログレベルの数値マッピング（高いほど詳細） */
const LEVEL_NUM: Record<string, number> = {
  off: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

let _outputChannel: vscode.OutputChannel | undefined;
let _levelNum = LEVEL_NUM['info'];

/** ロガーを初期化する（activate() 内で一度だけ呼ぶ） */
export function initLogger(context: vscode.ExtensionContext): void {
  _outputChannel = vscode.window.createOutputChannel('Remote - Mosh');
  context.subscriptions.push(_outputChannel);
  refreshLevel();

  // 設定変更時にレベルを再読み込み
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('remoteMosh.logLevel')) {
        refreshLevel();
      }
    })
  );
}

function refreshLevel(): void {
  const level: string = vscode.workspace
    .getConfiguration('remoteMosh')
    .get<string>('logLevel', 'info');
  _levelNum = LEVEL_NUM[level] ?? LEVEL_NUM['info'];
}

function log(levelStr: string, levelNum: number, ...args: unknown[]): void {
  if (levelNum > _levelNum) {
    return;
  }
  const ts = new Date().toISOString();
  const msg = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line = `[${ts}] [${levelStr.toUpperCase().padEnd(5)}] [Remote-Mosh] ${msg}`;
  _outputChannel?.appendLine(line);
  // trace/debug は console にも出力（開発時）
  if (levelNum >= LEVEL_NUM['debug']) {
    console.log(line);
  }
}

export const logger = {
  error(...args: unknown[]): void { log('error', 0, ...args); },
  warn(...args: unknown[]): void  { log('warn',  1, ...args); },
  info(...args: unknown[]): void  { log('info',  2, ...args); },
  debug(...args: unknown[]): void { log('debug', 3, ...args); },
  trace(...args: unknown[]): void { log('trace', 4, ...args); },

  /** OutputChannel を表示する */
  show(): void { _outputChannel?.show(true); },
};
