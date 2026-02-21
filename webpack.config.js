//@ts-check
'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/** @type {import('webpack').Configuration} */
const extensionConfig = {
  target: 'node', // VS Code extensions run in a Node.js context
  mode: 'none',   // this leaves the source code as close as possible to the original

  entry: './src/extension.ts',
  output: {
    // The bundle is stored in the 'dist' folder (check .vscodeignore), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
    devtoolModuleFilenameTemplate: '../[resource-path]',
  },
  externals: {
    // The vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    vscode: 'commonjs vscode',
    // These node built-ins are provided by the VS Code extension host
    // and must NOT be bundled
    fs: 'commonjs fs',
    path: 'commonjs path',
    os: 'commonjs os',
    crypto: 'commonjs crypto',
    net: 'commonjs net',
    tls: 'commonjs tls',
    dgram: 'commonjs dgram',
    dns: 'commonjs dns',
    stream: 'commonjs stream',
    events: 'commonjs events',
    buffer: 'commonjs buffer',
    child_process: 'commonjs child_process',
    // ssh2 uses native .node binaries (cpu-features, sshcrypto) that cannot
    // be bundled by webpack. Mark as external so the extension host loads them
    // from node_modules/ at runtime.
    ssh2: 'commonjs ssh2',
    'cpu-features': 'commonjs cpu-features',
    // mosh-wasm is loaded at runtime via webpackIgnore dynamic require.
    // Mark as external so webpack does not attempt to bundle the WASM binary.
    'mosh-wasm': 'commonjs mosh-wasm',
  },
  resolve: {
    // Support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js'],
    fallback: {
      // Provide no-op shims for packages that aren't available in Node.js extension host
    },
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
            options: {
              // Transpile only - type checking is done by `npm run compile`
              transpileOnly: true,
            },
          },
        ],
      },
      {
        // Handle WASM files: emit them as asset files so they can be loaded at runtime
        test: /\.wasm$/,
        type: 'asset/resource',
        generator: {
          filename: '[name][ext]',
        },
      },
    ],
  },
  plugins: [
    // Copy mosh-wasm-pkg artifacts to dist/mosh-wasm-pkg/ for the webpack bundle.
    // The extension loads WASM at runtime via:
    //   1. require('mosh-wasm') → node_modules/mosh-wasm/ (development)
    //   2. path.join(__dirname, '..', 'mosh-wasm-pkg', 'mosh_wasm.js') (dist/ build)
    new CopyPlugin({
      patterns: [
        {
          from: path.resolve(__dirname, 'mosh-wasm-pkg'),
          to: path.resolve(__dirname, 'dist', 'mosh-wasm-pkg'),
          noErrorOnMissing: false,
          globOptions: {
            ignore: ['**/.gitignore'],
          },
        },
      ],
    }),
  ],
  // Helps sourcemaps in production builds
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log', // enables logging required for problem matchers
  },
  // Suppress warnings about large bundles (ssh2 can be large)
  performance: {
    hints: false,
  },
};

module.exports = [extensionConfig];
