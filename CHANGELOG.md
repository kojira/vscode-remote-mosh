# Changelog

All notable changes to **Remote - Mosh** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-02-21

### Added

- **Mosh transport over WASM** — Core mosh protocol implemented in Rust and compiled to WebAssembly (`mosh-wasm`), enabling pure JS/TS execution inside the VS Code extension host without native binaries.
- **SSH tunnel bootstrapping** — Automatic SSH connection via `ssh2` to start `mosh-server` on the remote host and retrieve the session key/port.
- **Remote authority resolver** (`mosh+<host>`) — Registers a custom VS Code remote authority so you can open `vscode://mosh+<host>/path` URIs seamlessly.
- **Connect command** (`Remote-Mosh: Connect to Host...`) — Interactive quick-pick to specify host, user, port, and identity file, then connect via Mosh.
- **Disconnect command** (`Remote-Mosh: Disconnect`) — Tear down the active Mosh connection gracefully.
- **Show Log command** (`Remote-Mosh: Show Log`) — Open the extension's output channel to inspect connection diagnostics.
- **Status bar integration** — Remote indicator shows "Mosh" when connected; clicking it reveals connect/disconnect options.
- **Configuration settings**:
  - `remoteMosh.defaultUser` — Default SSH username.
  - `remoteMosh.defaultPort` — Preferred UDP port for Mosh (default: `60001`).
  - `remoteMosh.identityFile` — Path to SSH private key.
  - `remoteMosh.serverPath` — Path to `mosh-server` on the remote host (default: `mosh-server`).
  - `remoteMosh.mtu` — UDP MTU (default: `500` for mobile/unstable networks).
  - `remoteMosh.logLevel` — Log verbosity (`off` | `error` | `warn` | `info` | `debug` | `trace`).
- **Webpack bundling** — Extension bundled with webpack for fast activation; WASM binary copied into `dist/mosh-wasm-pkg/`.
- **Unit test suite** — Mocha-based tests with VS Code API mock for CI compatibility (no VS Code process required).

### Implementation Details

- **mosh-crypto** crate: AES-128-OCB3 AEAD encryption (pure Rust, `RustCrypto` stack).
- **mosh-proto** crate: Protocol Buffer message definitions (via `prost`).
- **mosh-transport** crate: Mosh UDP transport state machine.
- **mosh-ssp** crate: Server startup protocol (SSH → mosh-server handshake).
- **mosh-stream** crate: Higher-level stream abstraction over transport.
- **mosh-wasm** crate: `wasm-bindgen` exports; compiled to `nodejs` target via `wasm-pack`.

### Notes

- This is a **preview** release (`"preview": true`). APIs are subject to change.
- Requires VS Code 1.85.0 or later.
- The `resolvers` proposed API must be enabled in VS Code Insiders / with the appropriate flag.
- `mosh-server` must be installed on the remote host separately.

---

## [Unreleased]

- Terminal integration (PTY forwarding over Mosh transport)
- File system provider (edit remote files directly)
- Port forwarding support
- Reconnection / session resume on network change
- Windows support for the SSH bootstrap layer

---

[0.1.0]: https://github.com/kojira/vscode-remote-mosh/releases/tag/v0.1.0
[Unreleased]: https://github.com/kojira/vscode-remote-mosh/compare/v0.1.0...HEAD
