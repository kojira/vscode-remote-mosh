/**
 * runTest.ts
 *
 * Mocha テストランナー。
 * `npm test` から `node ./out/test/runTest.js` として呼ばれる。
 *
 * セットアップ:
 * 1. `vscode` モジュールをモックに差し替える（require.cache 操作）
 * 2. suite/ 以下のテストファイルをすべて Mocha に追加
 * 3. テストを実行し、失敗があれば process.exit(1) で終了
 */

// ────────────────────────────────────────────────────────────────────────────
// Step 1: vscode モックをセットアップ（テストモジュールの import 前に実行）
// ────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module');
const originalResolveFilename = Module._resolveFilename.bind(Module);

Module._resolveFilename = function (
  request: string,
  parent: unknown,
  isMain: boolean,
  options: unknown
): string {
  if (request === 'vscode') {
    // vscode モジュールのリクエストをモックにリダイレクト
    return require.resolve('./mocks/vscode');
  }
  return originalResolveFilename(request, parent, isMain, options);
};

// ────────────────────────────────────────────────────────────────────────────
// Step 2: Mocha テストランナーのセットアップ
// ────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Mocha = require('mocha');
import * as path from 'path';
import * as fs from 'fs';

async function run(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 15_000,
    reporter: 'spec',
  });

  const testsRoot = path.resolve(__dirname, 'suite');

  if (!fs.existsSync(testsRoot)) {
    console.error(`Test suite directory not found: ${testsRoot}`);
    process.exit(1);
  }

  // suite/ 以下の .test.js ファイルをすべて追加
  const testFiles = fs
    .readdirSync(testsRoot)
    .filter((f) => f.endsWith('.test.js'))
    .sort();

  if (testFiles.length === 0) {
    console.warn('No test files found in', testsRoot);
    return;
  }

  console.log(`\nFound ${testFiles.length} test file(s):`);
  for (const file of testFiles) {
    console.log(`  - ${file}`);
    mocha.addFile(path.resolve(testsRoot, file));
  }
  console.log();

  // テスト実行
  return new Promise<void>((resolve, reject) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      mocha.run((failures: number) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed`));
        } else {
          console.log('\n✅ All tests passed!\n');
          resolve();
        }
      });
    } catch (err) {
      reject(err);
    }
  });
}

run().catch((err) => {
  console.error('\n❌ Test runner error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
