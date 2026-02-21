/**
 * mosh-client.ts
 *
 * mosh-wasm（Rust/wasm-bindgen）のラッパー層。
 *
 * ## 役割
 * 1. mosh-wasm パッケージの動的ロード
 * 2. MoshWasmClient ラッパークラス（型安全なインターフェース）
 * 3. Node.js `dgram` UDP ソケット → WASM へのブリッジ
 *
 * ## WASM ビルド状況
 * mosh-wasm は `/Volumes/2TB/dev/projects/mosh-wasm/` に Rust で実装中。
 * `wasm-pack build --target nodejs` でビルド後、`mosh-wasm-pkg/` が生成される。
 *
 * ## 現在の状態
 * WASM がビルドされていないため、WasmModule インターフェースはモックとして
 * 型定義のみ提供。実際の接続は `loadMoshWasm()` が解決されてから動作する。
 */
import * as dgram from 'dgram';
import * as path from 'path';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// WASM モジュールの型定義（wasm-bindgen が生成する mosh_wasm.d.ts に準拠）
// ---------------------------------------------------------------------------

/**
 * wasm-bindgen が生成する MoshClient クラスの型定義。
 * 実際の型は `mosh-wasm-pkg/mosh_wasm.d.ts` に同定義が存在する。
 */
export interface IMoshWasmClient {
  /** UDP 受信バイトを処理し、上位レイヤーに渡すデータを返す */
  recvUdpPacket(udpBytes: Uint8Array, nowMs: number): Uint8Array;
  /** VS Code RPC データを mosh パケットに変換して返す */
  sendData(data: Uint8Array, nowMs: number): Uint8Array[];
  /** 定期 tick（50ms ごと）：ハートビート・再送管理 */
  tick(nowMs: number): Uint8Array[];
  /** 読み取り待ちデータがあるか */
  hasPendingRead(): boolean;
  /** バッファのデータを全部読み出す */
  readPending(): Uint8Array;
  /** セッション統計（JSON 文字列） */
  getStats(): string;
  /** リソース解放（明示的に呼ぶことを推奨） */
  free(): void;
}

/** wasm-bindgen が生成するモジュール全体の型定義 */
interface MoshWasmModule {
  MoshClient: new (keyBase64: string, mtu?: number) => IMoshWasmClient;
  init_panic_hook(): void;
  decodeBase64Key(keyB64: string): Uint8Array;
}

/** mosh セッション統計 */
export interface MoshStats {
  srtt_ms: number;
  rto_ms: number;
  send_num: number;
  recv_num: number;
  pending_count: number;
  total_sent_bytes: number;
  total_recv_bytes: number;
}

// ---------------------------------------------------------------------------
// WASM ローダー
// ---------------------------------------------------------------------------

let _wasmModule: MoshWasmModule | null = null;
let _wasmLoadPromise: Promise<MoshWasmModule> | null = null;

/**
 * mosh-wasm パッケージを動的ロードする。
 *
 * ロード優先順:
 * 1. npm パッケージ `mosh-wasm`（node_modules/mosh-wasm）
 * 2. プロジェクトルートの `mosh-wasm-pkg/` ディレクトリ
 * 3. dist/ 直下の `mosh-wasm-pkg/` ディレクトリ
 * 4. モック実装（WASM 未ビルド時のフォールバック）
 *
 * @throws WASM ロード失敗時（モックで代替）
 */
export async function loadMoshWasm(): Promise<MoshWasmModule> {
  if (_wasmModule) {
    return _wasmModule;
  }
  if (_wasmLoadPromise) {
    return _wasmLoadPromise;
  }

  _wasmLoadPromise = (async () => {
    // 1. まず npm パッケージ経由でロードを試みる（本番・開発共通）
    try {
      // webpackIgnore: webpack がバンドル時に解決しようとするのを防ぐ
      // WASM ファイルはランタイムに node_modules から直接ロードする
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(/* webpackIgnore: true */ 'mosh-wasm') as MoshWasmModule;
      mod.init_panic_hook();
      logger.info('mosh-wasm loaded from npm package');
      _wasmModule = mod;
      return mod;
    } catch (npmErr) {
      logger.debug('mosh-wasm npm package not available, trying file paths...', npmErr);
    }

    // 2. ファイルシステムからのパスを探す（フォールバック）
    const candidates = [
      path.join(__dirname, '..', 'mosh-wasm-pkg', 'mosh_wasm.js'),
      path.join(__dirname, 'mosh-wasm-pkg', 'mosh_wasm.js'),
      path.join(__dirname, '..', 'mosh-wasm', 'crates', 'mosh-wasm', 'pkg', 'mosh_wasm.js'),
    ];

    let modulePath: string | undefined;
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        modulePath = candidate;
        break;
      }
    }

    if (modulePath) {
      logger.info(`Loading mosh-wasm from file: ${modulePath}`);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(/* webpackIgnore: true */ modulePath) as MoshWasmModule;
      mod.init_panic_hook();
      logger.info('mosh-wasm loaded successfully from file path');
      _wasmModule = mod;
      return mod;
    }

    // 3. WASM が見つからない場合はモック実装にフォールバック
    logger.warn(
      'mosh-wasm package not found. Using MOCK implementation.',
      'Run: cd /Volumes/2TB/dev/projects/mosh-wasm && ' +
      'wasm-pack build crates/mosh-wasm --target nodejs ' +
      '--out-dir /Volumes/2TB/dev/projects/vscode-remote-mosh/mosh-wasm-pkg'
    );
    return createMockWasmModule();
  })();

  return _wasmLoadPromise;
}

// ---------------------------------------------------------------------------
// MoshClientWrapper（UDP socket + WASM クライアントのブリッジ）
// ---------------------------------------------------------------------------

/** MoshClientWrapper のイベント一覧 */
interface MoshClientEvents {
  /** VS Code RPC に渡す受信データ */
  data: (chunk: Uint8Array) => void;
  /** 接続クローズ（エラーあり or なし） */
  close: (err?: Error) => void;
  /** FIN 受信 */
  end: () => void;
}

/**
 * mosh-wasm + Node.js UDP ソケットを統合したクライアントラッパー。
 *
 * 使用例:
 * ```typescript
 * const client = await MoshClientWrapper.connect({
 *   host: 'example.com',
 *   udpPort: 60001,
 *   keyBase64: '4NeCCgvZFe2RnPgrcU1PQw',
 *   mtu: 500,
 * });
 * client.on('data', (chunk) => {
 *   // VS Code RPC に渡す
 * });
 * client.send(rpcData);
 * ```
 */
export class MoshClientWrapper extends EventEmitter {
  private readonly _wasm: IMoshWasmClient;
  private readonly _socket: dgram.Socket;
  private readonly _host: string;
  private readonly _udpPort: number;
  private _tickTimer: ReturnType<typeof setInterval> | undefined;
  private _closed = false;

  private constructor(
    wasm: IMoshWasmClient,
    socket: dgram.Socket,
    host: string,
    udpPort: number
  ) {
    super();
    this._wasm = wasm;
    this._socket = socket;
    this._host = host;
    this._udpPort = udpPort;
  }

  /**
   * mosh-server に UDP 接続してラッパーを生成する。
   *
   * @param opts 接続オプション
   */
  static async connect(opts: {
    host: string;
    udpPort: number;
    keyBase64: string;
    mtu?: number;
  }): Promise<MoshClientWrapper> {
    const { host, udpPort, keyBase64, mtu = 500 } = opts;

    logger.info(`MoshClientWrapper.connect: ${host}:${udpPort} (MTU=${mtu})`);

    // 1. WASM モジュールをロード
    const wasmMod = await loadMoshWasm();

    // 2. MoshClient（WASM）を初期化
    const wasmClient = new wasmMod.MoshClient(keyBase64, mtu);
    logger.debug('MoshClient (WASM) initialized');

    // 3. UDP ソケットを作成・接続
    const socket = dgram.createSocket('udp4');

    const wrapper = new MoshClientWrapper(wasmClient, socket, host, udpPort);

    // UDP ソケットのイベントハンドラを登録
    socket.on('message', (msg: Buffer) => wrapper._onUdpMessage(msg));
    socket.on('error', (err: Error) => wrapper._onSocketError(err));
    socket.on('close', () => wrapper._onSocketClose());

    // 4. UDP ソケットをバインド＆接続
    await new Promise<void>((resolve, reject) => {
      socket.bind(() => {
        try {
          socket.connect(udpPort, host, () => {
            logger.info(`UDP socket connected to ${host}:${udpPort}`);
            resolve();
          });
        } catch (err) {
          reject(err);
        }
      });
      socket.once('error', reject);
    });

    // 5. 定期 tick タイマーを起動（50ms ごと）
    wrapper._startTickTimer();

    return wrapper;
  }

  /**
   * VS Code RPC データを mosh 経由で送信する。
   * `ManagedMessagePassing.send()` から呼ばれる。
   */
  send(data: Uint8Array): void {
    if (this._closed) {
      return;
    }
    try {
      const packets = this._wasm.sendData(data, Date.now());
      for (const pkt of packets) {
        this._sendUdpPacket(pkt);
      }
    } catch (err) {
      logger.error('mosh sendData error:', err);
    }
  }

  /**
   * セッションを終了する。
   * `ManagedMessagePassing.end()` から呼ばれる。
   */
  end(): void {
    if (this._closed) {
      return;
    }
    logger.info('MoshClientWrapper.end() called');
    this._cleanup();
    this.emit('end');
  }

  /**
   * ドレイン（送信バッファが空になるまで待つ）。
   * `ManagedMessagePassing.drain()` から呼ばれる。
   */
  drain(): Promise<void> {
    // TODO: 実装。現状は即座に解決。
    return Promise.resolve();
  }

  /** セッション統計を返す */
  getStats(): MoshStats {
    try {
      return JSON.parse(this._wasm.getStats()) as MoshStats;
    } catch {
      return {
        srtt_ms: -1,
        rto_ms: 200,
        send_num: 0,
        recv_num: 0,
        pending_count: 0,
        total_sent_bytes: 0,
        total_recv_bytes: 0,
      };
    }
  }

  // ------ private ------

  private _onUdpMessage(msg: Buffer): void {
    if (this._closed) {
      return;
    }
    try {
      const bytes = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
      const data = this._wasm.recvUdpPacket(bytes, Date.now());
      if (data.length > 0) {
        logger.trace(`UDP recv → ${data.length} bytes decoded`);
        this.emit('data', data);
      }
    } catch (err) {
      // パケットロス・復号失敗は接続断ではないので warn に留める
      logger.warn('mosh recvUdpPacket error (packet loss?):', err);
    }
  }

  private _onSocketError(err: Error): void {
    logger.error('UDP socket error:', err);
    this._cleanup(err);
    this.emit('close', err);
  }

  private _onSocketClose(): void {
    if (!this._closed) {
      logger.info('UDP socket closed unexpectedly');
      this._cleanup();
      this.emit('close');
    }
  }

  private _sendUdpPacket(pkt: Uint8Array): void {
    this._socket.send(Buffer.from(pkt), (err) => {
      if (err) {
        logger.warn('UDP send error:', err);
      }
    });
  }

  private _startTickTimer(): void {
    this._tickTimer = setInterval(() => {
      if (this._closed) {
        clearInterval(this._tickTimer);
        return;
      }
      try {
        const packets = this._wasm.tick(Date.now());
        for (const pkt of packets) {
          this._sendUdpPacket(pkt);
        }
      } catch (err) {
        logger.warn('mosh tick error:', err);
      }
    }, 50); // 50ms ごと（mosh 推奨値）
  }

  private _cleanup(err?: Error): void {
    if (this._closed) {
      return;
    }
    this._closed = true;
    if (this._tickTimer !== undefined) {
      clearInterval(this._tickTimer);
      this._tickTimer = undefined;
    }
    try {
      this._socket.close();
    } catch {
      // already closed
    }
    try {
      this._wasm.free();
    } catch {
      // ignore
    }
    logger.info('MoshClientWrapper cleanup done', err ? `(reason: ${err.message})` : '');
  }

  // typed emit overloads
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: 'data', chunk: Uint8Array): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: 'close', err?: Error): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: 'end'): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  on(event: 'data', listener: MoshClientEvents['data']): this;
  on(event: 'close', listener: MoshClientEvents['close']): this;
  on(event: 'end', listener: MoshClientEvents['end']): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string | symbol, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

// ---------------------------------------------------------------------------
// モック実装（WASM がビルドされるまでの開発用スタブ）
// ---------------------------------------------------------------------------

/**
 * WASM が未ビルドの開発段階で使うモック。
 * 実際の暗号化は行わず、ログ出力のみ。
 *
 * TODO: wasm-pack build が完了したら削除
 */
function createMockWasmModule(): MoshWasmModule {
  class MockMoshClient implements IMoshWasmClient {
    private readonly _key: string;
    private _sendNum = 0;
    private _recvNum = 0;
    private _totalSent = 0;
    private _totalRecv = 0;

    constructor(keyBase64: string, _mtu?: number) {
      this._key = keyBase64;
      logger.warn(`[MOCK] MoshClient created with key=${keyBase64.substring(0, 8)}...`);
    }

    recvUdpPacket(udpBytes: Uint8Array, _nowMs: number): Uint8Array {
      this._recvNum++;
      this._totalRecv += udpBytes.length;
      logger.trace(`[MOCK] recvUdpPacket: ${udpBytes.length} bytes`);
      // モックでは受信データをそのまま返す（実際はデコードが必要）
      return udpBytes;
    }

    sendData(data: Uint8Array, _nowMs: number): Uint8Array[] {
      this._sendNum++;
      this._totalSent += data.length;
      logger.trace(`[MOCK] sendData: ${data.length} bytes`);
      // モックでは1パケットとしてそのまま返す
      return [data];
    }

    tick(_nowMs: number): Uint8Array[] {
      // モックではハートビートは送らない
      return [];
    }

    hasPendingRead(): boolean {
      return false;
    }

    readPending(): Uint8Array {
      return new Uint8Array(0);
    }

    getStats(): string {
      return JSON.stringify({
        srtt_ms: -1,
        rto_ms: 200,
        send_num: this._sendNum,
        recv_num: this._recvNum,
        pending_count: 0,
        total_sent_bytes: this._totalSent,
        total_recv_bytes: this._totalRecv,
      } satisfies MoshStats);
    }

    free(): void {
      logger.trace(`[MOCK] MoshClient.free() key=${this._key.substring(0, 8)}...`);
    }
  }

  return {
    MoshClient: MockMoshClient,
    init_panic_hook: () => {
      logger.debug('[MOCK] init_panic_hook() called');
    },
    decodeBase64Key: (keyB64: string): Uint8Array => {
      // Base64 デコード（Node.js 組み込み）
      const buf = Buffer.from(keyB64, 'base64');
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  };
}
