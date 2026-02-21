/**
 * vscode.ts (mock)
 *
 * VS Code API のモック実装。テスト環境で実際の VS Code なしに
 * 拡張機能のロジックをテストするために使用する。
 */

// EventEmitter の簡易実装
class EventEmitterMock<T> {
  private readonly _listeners: Array<(e: T) => void> = [];

  get event(): (listener: (e: T) => void) => { dispose: () => void } {
    return (listener: (e: T) => void) => {
      this._listeners.push(listener);
      return {
        dispose: () => {
          const idx = this._listeners.indexOf(listener);
          if (idx >= 0) {
            this._listeners.splice(idx, 1);
          }
        },
      };
    };
  }

  fire(e: T): void {
    for (const listener of this._listeners) {
      listener(e);
    }
  }

  dispose(): void {
    this._listeners.length = 0;
  }
}

// OutputChannel モック
class OutputChannelMock {
  readonly name: string;
  private _lines: string[] = [];

  constructor(name: string) {
    this.name = name;
  }

  appendLine(value: string): void {
    this._lines.push(value);
  }

  show(): void {
    // no-op
  }

  dispose(): void {
    this._lines = [];
  }

  getLines(): string[] {
    return this._lines;
  }
}

// StatusBarItem モック
class StatusBarItemMock {
  text = '';
  tooltip: string | undefined;
  command: string | undefined;
  backgroundColor: unknown = undefined;
  private _visible = false;

  show(): void { this._visible = true; }
  hide(): void { this._visible = false; }
  dispose(): void { this._visible = false; }
  isVisible(): boolean { return this._visible; }
}

// ManagedResolvedAuthority モック
class ManagedResolvedAuthority {
  readonly makeConnection: () => Promise<unknown>;
  readonly connectionToken: string;

  constructor(makeConnection: () => Promise<unknown>, connectionToken: string) {
    this.makeConnection = makeConnection;
    this.connectionToken = connectionToken;
  }
}

// RemoteAuthorityResolverError モック
class RemoteAuthorityResolverError extends Error {
  static TemporarilyNotAvailable(msg: string): RemoteAuthorityResolverError {
    return new RemoteAuthorityResolverError(msg, 'TemporarilyNotAvailable');
  }
  static NotAvailable(msg: string): RemoteAuthorityResolverError {
    return new RemoteAuthorityResolverError(msg, 'NotAvailable');
  }
  static NoInformation(msg: string): RemoteAuthorityResolverError {
    return new RemoteAuthorityResolverError(msg, 'NoInformation');
  }

  readonly _type: string;
  constructor(message: string, type: string) {
    super(message);
    this._type = type;
    this.name = 'RemoteAuthorityResolverError';
  }
}

// ProgressLocation enum
const ProgressLocation = {
  Explorer: 1,
  Scm: 3,
  Extensions: 5,
  Window: 10,
  Notification: 15,
  Dialog: 20,
} as const;

// ThemeColor モック
class ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

// StatusBarAlignment enum
const StatusBarAlignment = {
  Left: 1,
  Right: 2,
} as const;

// Uri モック
class Uri {
  readonly scheme: string;
  readonly authority: string;
  readonly path: string;
  private readonly _raw: string;

  private constructor(scheme: string, authority: string, path: string, raw: string) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = path;
    this._raw = raw;
  }

  static parse(value: string): Uri {
    const url = new URL(value);
    return new Uri(url.protocol.replace(':', ''), url.host, url.pathname, value);
  }

  toString(): string {
    return this._raw;
  }
}

// workspace モック
const workspace = {
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, defaultValue: T): T => defaultValue,
    has: (_key: string) => false,
    inspect: () => undefined,
    update: () => Promise.resolve(),
  }),
  registerRemoteAuthorityResolver: (_scheme: string, _resolver: unknown) => ({
    dispose: () => { /* no-op */ },
  }),
  onDidChangeConfiguration: (_handler: unknown) => ({ dispose: () => { /* no-op */ } }),
};

// window モック
const window = {
  createOutputChannel: (name: string) => new OutputChannelMock(name),
  createStatusBarItem: (_alignment: unknown, _priority: unknown) => new StatusBarItemMock(),
  showInputBox: () => Promise.resolve(undefined),
  showWarningMessage: () => Promise.resolve(undefined),
  showErrorMessage: () => Promise.resolve(undefined),
  withProgress: async (_opts: unknown, task: (progress: unknown) => Promise<void>) => {
    await task({ report: () => { /* no-op */ } });
  },
};

// commands モック
const commands = {
  registerCommand: (_command: string, _callback: unknown) => ({ dispose: () => { /* no-op */ } }),
  executeCommand: () => Promise.resolve(),
};

// env モック
const env = {
  remoteName: undefined as string | undefined,
  remoteAuthority: undefined as string | undefined,
  appHost: 'desktop',
};

// モジュールエクスポート（VS Code API 互換）
module.exports = {
  EventEmitter: EventEmitterMock,
  OutputChannel: OutputChannelMock,
  StatusBarItem: StatusBarItemMock,
  ManagedResolvedAuthority,
  RemoteAuthorityResolverError,
  ProgressLocation,
  ThemeColor,
  StatusBarAlignment,
  Uri,
  workspace,
  window,
  commands,
  env,
  version: '1.85.0-test',
};
