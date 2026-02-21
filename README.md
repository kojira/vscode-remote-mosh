# Remote - Mosh

> **⚠️ Preview / Work In Progress**: This extension is under active development. The WASM-based mosh transport is not yet complete.

Open any folder on a remote machine over **[Mosh (Mobile Shell)](https://mosh.org)** — survives network drops, Wi-Fi → LTE roaming, and sleeps without losing your VS Code session.

## Features

| Feature | Status |
|---------|--------|
| Remote file editing via VS Code Server | 🚧 In Progress |
| LSP (code completion, diagnostics) | 🚧 In Progress |
| Integrated terminal | 🚧 In Progress |
| Network roaming (Wi-Fi → LTE, IP change) | 🚧 In Progress |
| Auto-reconnect after sleep/suspend | 🚧 In Progress |
| Transparent mosh SSP over UDP | 🚧 In Progress (WASM) |

## Architecture

```
[VS Code] ─ vscode-remote://mosh+user@host/path
    │
    ├─ RemoteAuthorityResolver ('mosh')
    │      └─ resolve() → SSH → mosh-server → ManagedResolvedAuthority
    │
    └─ ManagedMessagePassing
           └─ MoshClientWrapper
                  ├─ mosh-wasm (Rust/WASM) ← SSP + AES-128-OCB3
                  └─ Node.js dgram (UDP socket)

                         ↕ UDP (port 60001-61000) / AES-128-OCB3

                  [Remote] mosh-server → vscode-server (stdio)
```

## Requirements

### Local Machine

- **VS Code** `>= 1.85.0`
- **Node.js** `>= 18` (bundled with VS Code)
- **SSH access** to the remote host (key-based auth recommended)

### Remote Machine

- **mosh-server** `>= 1.3`
  ```bash
  # Ubuntu / Debian
  sudo apt install mosh
  # RHEL / Fedora
  sudo dnf install mosh
  # macOS (for testing)
  brew install mosh
  ```
- **UDP port range open**: `60001–61000` (one port is used per connection)
- **vscode-server** (auto-downloaded on first connect)

## Setup

### 1. Install the Extension

```bash
# From source (development)
git clone https://github.com/kojira/vscode-remote-mosh
cd vscode-remote-mosh
npm install
npm run compile
```

Then press **F5** in VS Code to launch the Extension Development Host.

### 2. Connect to a Remote Host

In the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

```
> Remote-SSH: Connect to Host...
```

Or open a URI directly:

```
vscode-remote://mosh+user@hostname/path/to/folder
vscode-remote://mosh+user@hostname:2222/path/to/folder
```

### 3. Configuration

Open **Settings** (`Cmd+,`) and search for `remoteMosh`:

| Setting | Default | Description |
|---------|---------|-------------|
| `remoteMosh.defaultUser` | *(OS user)* | Default SSH username |
| `remoteMosh.defaultPort` | `60001` | Preferred UDP port for mosh |
| `remoteMosh.identityFile` | *(SSH agent)* | Path to SSH private key (e.g. `~/.ssh/id_ed25519`) |
| `remoteMosh.serverPath` | `mosh-server` | Path to mosh-server on remote |
| `remoteMosh.mtu` | `500` | UDP MTU (500 for mobile, 1400 for LAN) |
| `remoteMosh.logLevel` | `info` | Log verbosity (`off`/`error`/`warn`/`info`/`debug`/`trace`) |

## Development

### Project Structure

```
vscode-remote-mosh/
├── src/
│   ├── extension.ts          # Main entry point, RemoteAuthorityResolver
│   ├── mosh-client.ts        # WASM wrapper + UDP socket bridge
│   ├── config.ts             # Settings helpers
│   ├── logger.ts             # VS Code OutputChannel logger
│   └── vscode.proposed.resolvers.d.ts  # Proposed API types
├── .vscode/
│   ├── launch.json           # F5 debug configurations
│   └── tasks.json            # Build tasks
├── dist/                     # webpack output (gitignored)
├── out/                      # tsc output (gitignored)
├── package.json              # Extension manifest
├── tsconfig.json
└── webpack.config.js
```

### Build Commands

```bash
# Install dependencies
npm install

# TypeScript type check + compile to out/
npm run compile

# TypeScript watch mode (auto-recompile on save)
npm run watch

# webpack bundle to dist/ (development mode)
npm run webpack

# webpack bundle to dist/ (production mode)
npm run package

# Clean build artifacts
npm run clean

# Fetch latest proposed API types
npm run fetch-proposed-api
```

### Debugging

1. Open the project in VS Code:
   ```bash
   code /Volumes/2TB/dev/projects/vscode-remote-mosh
   ```

2. Press **F5** → Select **"Run Extension"**

   This launches a new VS Code window (Extension Development Host) with the extension loaded.

3. In the Extension Development Host window, open the Output panel:
   - **View → Output** → Select **"Remote - Mosh"** from the dropdown

4. To connect to a mosh host, use the URI format:
   ```
   vscode-remote://mosh+user@your-server.example.com/home/user
   ```

### Building mosh-wasm (Rust → WASM)

The transport layer is implemented in Rust. The WASM build is required for actual mosh connections:

```bash
# Prerequisites
curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh

# Build
cd /Volumes/2TB/dev/projects/mosh-wasm
wasm-pack build --target nodejs crates/mosh-wasm

# The output is in: crates/mosh-wasm/pkg/
```

After building, update `webpack.config.js` to copy the WASM package to `dist/`:

```js
// Uncomment in webpack.config.js:
new CopyPlugin({
  patterns: [
    {
      from: path.resolve(__dirname, '../mosh-wasm/crates/mosh-wasm/pkg'),
      to: path.resolve(__dirname, 'dist/mosh-wasm-pkg'),
    },
  ],
}),
```

### Proposed API

This extension uses VS Code's **proposed API** (`resolvers`). This is the same API used by Remote-SSH and Remote-Tunnels extensions.

To run the extension in development, VS Code must be launched with:
```
--enable-proposed-api=kojira.vscode-remote-mosh
```

This is already configured in `.vscode/launch.json`.

## How It Works

### Connection Flow

```
1. User opens vscode-remote://mosh+user@host/path

2. RemoteAuthorityResolver.resolve() is called
   ├─ SSH connect to remote (using ssh2)
   ├─ Start mosh-server: `mosh-server new -s -p 60001 -- /bin/bash`
   └─ Parse: "MOSH CONNECT 60001 4NeCCgvZFe2RnPgrcU1PQw"

3. Return ManagedResolvedAuthority(makeConnection)

4. VS Code calls makeConnection()
   ├─ Load mosh-wasm (or mock)
   ├─ Initialize MoshClient(keyBase64, mtu)
   ├─ Create dgram UDP socket
   └─ Return MoshMessagePassing (bidirectional byte stream)

5. VS Code protocol flows through the mosh channel:
   ├─ File system operations
   ├─ LSP (Language Server Protocol)
   ├─ Debug Adapter Protocol
   └─ Integrated terminal

6. Network drop / IP change → mosh SSP handles transparently
   └─ VS Code session continues without interruption
```

### mosh-wasm API

The Rust WASM module exposes:

```typescript
const client = new MoshClient(keyBase64, mtu);

// On UDP receive (from dgram socket)
socket.on('message', (msg) => {
    const data = client.recvUdpPacket(new Uint8Array(msg.buffer), Date.now());
    if (data.length > 0) {
        onData(data); // → VS Code RPC
    }
});

// On VS Code RPC send
function send(data: Uint8Array) {
    const packets = client.sendData(data, Date.now());
    for (const pkt of packets) {
        socket.send(Buffer.from(pkt));
    }
}

// Heartbeat / retransmit timer (every 50ms)
setInterval(() => {
    for (const pkt of client.tick(Date.now())) {
        socket.send(Buffer.from(pkt));
    }
}, 50);
```

## Related Projects

| Project | Description |
|---------|-------------|
| [mosh](https://github.com/mobile-shell/mosh) | The Mobile Shell |
| [mosh-wasm](../mosh-wasm/) | Rust/WASM implementation of mosh SSP |
| [VS Code Remote SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) | Reference implementation using the same proposed API |
| [mosh-chrome](https://github.com/rpwoodbu/mosh-chrome) | Historical NaCl port of mosh-client (architecture reference) |

## License

MIT — see [LICENSE](LICENSE)

## Contributing

Issues and PRs welcome! See the design document at:
`/Users/kojira/.openclaw-agent2/workspace/vscode-remote-mosh-design.md`
