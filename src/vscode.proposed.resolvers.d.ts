/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// This file is fetched from:
// https://raw.githubusercontent.com/microsoft/vscode/main/src/vscode-dts/vscode.proposed.resolvers.d.ts
//
// To update: run `npm run fetch-proposed-api` (npx @vscode/dts dev resolvers)

declare module 'vscode' {

	//resolvers: @alexdima

	export interface MessageOptions {
		/**
		 * Do not render a native message box.
		 */
		useCustom?: boolean;
	}

	export interface RemoteAuthorityResolverContext {
		resolveAttempt: number;
		/**
		 * Exec server from a recursively-resolved remote authority. If the
		 * remote authority includes nested authorities delimited by `@`, it is
		 * resolved from outer to inner authorities with ExecServer passed down
		 * to each resolver in the chain.
		 */
		execServer?: ExecServer;
	}

	export class ResolvedAuthority {
		readonly host: string;
		readonly port: number;
		readonly connectionToken: string | undefined;

		constructor(host: string, port: number, connectionToken?: string);
	}

	export interface ManagedMessagePassing {
		readonly onDidReceiveMessage: Event<Uint8Array>;
		readonly onDidClose: Event<Error | undefined>;
		readonly onDidEnd: Event<void>;

		send: (data: Uint8Array) => void;
		end: () => void;
		drain?: () => Thenable<void>;
	}

	export class ManagedResolvedAuthority {
		readonly makeConnection: () => Thenable<ManagedMessagePassing>;
		readonly connectionToken: string | undefined;

		constructor(makeConnection: () => Thenable<ManagedMessagePassing>, connectionToken?: string);
	}

	export interface ResolvedOptions {
		extensionHostEnv?: { [key: string]: string | null };

		isTrusted?: boolean;

		/**
		 * When provided, remote server will be initialized with the extensions synced using the given user account.
		 */
		authenticationSessionForInitializingExtensions?: AuthenticationSession & { providerId: string };
	}

	export interface TunnelPrivacy {
		themeIcon: string;
		id: string;
		label: string;
	}

	export namespace env {
		/** Quality of the application. May be undefined if running from sources. */
		export const appQuality: string | undefined;
		/** Commit of the application. May be undefined if running from sources. */
		export const appCommit: string | undefined;
	}

	export interface TunnelOptions {
		remoteAddress: { port: number; host: string };
		// The desired local port. If this port can't be used, then another will be chosen.
		localAddressPort?: number;
		label?: string;
		/**
		 * @deprecated Use privacy instead
		 */
		public?: boolean;
		privacy?: string;
		protocol?: string;
	}

	export interface TunnelDescription {
		remoteAddress: { port: number; host: string };
		//The complete local address(ex. localhost:1234)
		localAddress: { port: number; host: string } | string;
		/**
		 * @deprecated Use privacy instead
		 */
		public?: boolean;
		privacy?: string;
		// If protocol is not provided it is assumed to be http, regardless of the localAddress.
		protocol?: string;
	}

	export interface Tunnel extends TunnelDescription {
		// Implementers of Tunnel should fire onDidDispose when dispose is called.
		readonly onDidDispose: Event<void>;
		dispose(): void | Thenable<void>;
	}

	/**
	 * Used as part of the ResolverResult if the extension has any candidate,
	 * published, or forwarded ports.
	 */
	export interface TunnelInformation {
		/**
		 * Tunnels that are detected by the extension. The remotePort is used for display purposes.
		 * The localAddress should be the complete local address (ex. localhost:1234) for connecting to the port. Tunnels provided through
		 * detected are read-only from the forwarded ports UI.
		 */
		environmentTunnels?: TunnelDescription[];

		tunnelFeatures?: {
			elevation: boolean;
			/**
			 * One of the options must have the ID "private".
			 */
			privacyOptions: TunnelPrivacy[];
			/**
			 * Defaults to true for backwards compatibility.
			 */
			protocol?: boolean;
		};
	}

	export interface TunnelCreationOptions {
		/**
		 * True when the local operating system will require elevation to use the requested local port.
		 */
		elevationRequired?: boolean;
	}

	export enum CandidatePortSource {
		None = 0,
		Process = 1,
		Output = 2,
		Hybrid = 3
	}

	export type ResolverResult = (ResolvedAuthority | ManagedResolvedAuthority) & ResolvedOptions & TunnelInformation;

	export class RemoteAuthorityResolverError extends Error {
		static NotAvailable(message?: string, handled?: boolean): RemoteAuthorityResolverError;
		static TemporarilyNotAvailable(message?: string): RemoteAuthorityResolverError;

		constructor(message?: string);
	}

	/**
	 * An ExecServer allows spawning processes on a remote machine.
	 */
	export interface ExecServer {
		spawn(command: string, args: string[], options?: ExecServerSpawnOptions): Thenable<SpawnedCommand>;
		spawnRemoteServerConnector?(command: string, args: string[], options?: ExecServerSpawnOptions): Thenable<RemoteServerConnector>;
		downloadCliExecutable?(buildTarget: CliBuild, command: string, args: string[], options?: ExecServerSpawnOptions): Thenable<ProcessExit>;
		env(): Thenable<ExecEnvironment>;
		kill(processId: number): Thenable<void>;
		tcpConnect(
			host: string,
			port: number,
		): Thenable<{ stream: WriteStream & ReadStream; done: Thenable<void> }>;
		readonly fs: RemoteFileSystem;
	}

	export type ProcessEnv = Record<string, string>;

	export interface ExecServerSpawnOptions {
		readonly env?: ProcessEnv;
		readonly cwd?: string;
	}

	export interface SpawnedCommand {
		readonly stdin: WriteStream;
		readonly stdout: ReadStream;
		readonly stderr: ReadStream;
		readonly onExit: Thenable<ProcessExit>;
	}

	export interface RemoteServerConnector {
		readonly logs: ReadStream;
		readonly onExit: Thenable<ProcessExit>;
		connect(params: ServeParams): Thenable<ManagedMessagePassing>;
	}

	export interface ProcessExit {
		readonly status: number;
		readonly message?: string;
	}

	export interface ReadStream {
		readonly onDidReceiveMessage: Event<Uint8Array>;
		readonly onEnd: Thenable<void>;
	}

	export interface WriteStream {
		write(data: Uint8Array): void;
		end(): void;
	}

	export interface ServeParams {
		readonly socketId: number;
		readonly commit?: string;
		readonly quality: string;
		readonly extensions: string[];
		/** Whether server traffic should be compressed. */
		readonly compress?: boolean;
		/** Optional explicit connection token for the server. */
		readonly connectionToken?: string;
	}

	export interface CliBuild {
		readonly quality: string;
		readonly buildTarget: string;
		readonly commit: string;
	}

	export interface ExecEnvironment {
		readonly env: ProcessEnv;
		/** 'darwin' | 'linux' | 'win32' */
		readonly osPlatform: string;
		readonly osRelease?: string;
	}

	export interface RemoteFileSystem {
		stat(path: string): Thenable<FileStat>;
		mkdirp(path: string): Thenable<void>;
		rm(path: string): Thenable<void>;
		read(path: string): Thenable<ReadStream>;
		write(path: string): Thenable<{ stream: WriteStream; done: Thenable<void> }>;
		connect(path: string): Thenable<{ stream: WriteStream & ReadStream; done: Thenable<void> }>;
		rename(fromPath: string, toPath: string): Thenable<void>;
		readdir(path: string): Thenable<DirectoryEntry[]>;
	}

	export interface DirectoryEntry {
		type: FileType;
		name: string;
	}

	export interface RemoteAuthorityResolver {
		resolve(authority: string, context: RemoteAuthorityResolverContext): ResolverResult | Thenable<ResolverResult>;
		resolveExecServer?(remoteAuthority: string, context: RemoteAuthorityResolverContext): ExecServer | Thenable<ExecServer>;
		getCanonicalURI?(uri: Uri): ProviderResult<Uri>;
		tunnelFactory?: (tunnelOptions: TunnelOptions, tunnelCreationOptions: TunnelCreationOptions) => Thenable<Tunnel> | undefined;
		showCandidatePort?: (host: string, port: number, detail: string) => Thenable<boolean>;
		/** @deprecated */
		tunnelFeatures?: {
			elevation: boolean;
			public: boolean;
			privacyOptions: TunnelPrivacy[];
		};
		candidatePortSource?: CandidatePortSource;
	}

	export interface ResourceLabelFormatter {
		scheme: string;
		authority?: string;
		formatting: ResourceLabelFormatting;
	}

	export interface ResourceLabelFormatting {
		label: string;
		separator: '/' | '\\' | '';
		tildify?: boolean;
		normalizeDriveLetter?: boolean;
		workspaceSuffix?: string;
		workspaceTooltip?: string;
		authorityPrefix?: string;
		stripPathStartingSeparator?: boolean;
	}

	export namespace workspace {
		export function registerRemoteAuthorityResolver(authorityPrefix: string, resolver: RemoteAuthorityResolver): Disposable;
		export function registerResourceLabelFormatter(formatter: ResourceLabelFormatter): Disposable;
		export function getRemoteExecServer(authority: string): Thenable<ExecServer | undefined>;
	}

	export namespace env {
		export const remoteAuthority: string | undefined;
	}
}
