/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as net from 'net';
import { Barrier } from 'vs/base/common/async';
import { Disposable } from 'vs/base/common/lifecycle';
import { findFreePortFaster } from 'vs/base/node/ports';
import { NodeSocket } from 'vs/base/parts/ipc/node/ipc.net';
import { ILogService } from 'vs/platform/log/common/log';
import { IProductService } from 'vs/platform/product/common/productService';
import { connectRemoteAgentTunnel, IAddress, IConnectionOptions } from 'vs/platform/remote/common/remoteAgentConnection';
import { AbstractTunnelService, RemoteTunnel } from 'vs/platform/remote/common/tunnel';
import { nodeSocketFactory } from 'vs/platform/remote/node/nodeSocketFactory';
import { ISignService } from 'vs/platform/sign/common/sign';

async function createRemoteTunnel(options: IConnectionOptions, tunnelRemoteHost: string, tunnelRemotePort: number, tunnelLocalPort?: number): Promise<RemoteTunnel> {
	const tunnel = new NodeRemoteTunnel(options, tunnelRemoteHost, tunnelRemotePort, tunnelLocalPort);
	return tunnel.waitForReady();
}

class NodeRemoteTunnel extends Disposable implements RemoteTunnel {

	public readonly tunnelRemotePort: number;
	public tunnelLocalPort!: number;
	public tunnelRemoteHost: string;
	public localAddress!: string;

	private readonly _options: IConnectionOptions;
	private readonly _server: net.Server;
	private readonly _barrier: Barrier;

	private readonly _listeningListener: () => void;
	private readonly _connectionListener: (socket: net.Socket) => void;
	private readonly _errorListener: () => void;

	private readonly _socketsDispose: Map<string, () => void> = new Map();

	constructor(options: IConnectionOptions, tunnelRemoteHost: string, tunnelRemotePort: number, private readonly suggestedLocalPort?: number) {
		super();
		this._options = options;
		this._server = net.createServer();
		this._barrier = new Barrier();

		this._listeningListener = () => this._barrier.open();
		this._server.on('listening', this._listeningListener);

		this._connectionListener = (socket) => this._onConnection(socket);
		this._server.on('connection', this._connectionListener);

		// If there is no error listener and there is an error it will crash the whole window
		this._errorListener = () => { };
		this._server.on('error', this._errorListener);

		this.tunnelRemotePort = tunnelRemotePort;
		this.tunnelRemoteHost = tunnelRemoteHost;
	}

	public dispose(): void {
		super.dispose();
		this._server.removeListener('listening', this._listeningListener);
		this._server.removeListener('connection', this._connectionListener);
		this._server.removeListener('error', this._errorListener);
		this._server.close();
		const disposers = Array.from(this._socketsDispose.values());
		disposers.forEach(disposer => {
			disposer();
		});
	}

	public async waitForReady(): Promise<this> {
		// try to get the same port number as the remote port number...
		let localPort = await findFreePortFaster(this.suggestedLocalPort ?? this.tunnelRemotePort, 2, 1000);

		// if that fails, the method above returns 0, which works out fine below...
		let address: string | net.AddressInfo | null = null;
		address = (<net.AddressInfo>this._server.listen(localPort).address());

		// It is possible for findFreePortFaster to return a port that there is already a server listening on. This causes the previous listen call to error out.
		if (!address) {
			localPort = 0;
			address = (<net.AddressInfo>this._server.listen(localPort).address());
		}

		this.tunnelLocalPort = address.port;

		await this._barrier.wait();
		this.localAddress = 'localhost:' + address.port;
		return this;
	}

	private async _onConnection(localSocket: net.Socket): Promise<void> {
		// pause reading on the socket until we have a chance to forward its data
		localSocket.pause();

		const protocol = await connectRemoteAgentTunnel(this._options, this.tunnelRemotePort);
		const remoteSocket = (<NodeSocket>protocol.getSocket()).socket;
		const dataChunk = protocol.readEntireBuffer();
		protocol.dispose();

		if (dataChunk.byteLength > 0) {
			localSocket.write(dataChunk.buffer);
		}

		localSocket.on('end', () => {
			this._socketsDispose.delete(localSocket.localAddress);
			remoteSocket.end();
		});

		localSocket.on('close', () => remoteSocket.end());
		remoteSocket.on('end', () => localSocket.end());
		remoteSocket.on('close', () => localSocket.end());

		localSocket.pipe(remoteSocket);
		remoteSocket.pipe(localSocket);
		this._socketsDispose.set(localSocket.localAddress, () => {
			// Need to end instead of unpipe, otherwise whatever is connected locally could end up "stuck" with whatever state it had until manually exited.
			localSocket.end();
			remoteSocket.end();
		});
	}
}

export class TunnelService extends AbstractTunnelService {
	public constructor(
		@ILogService logService: ILogService,
		@ISignService private readonly signService: ISignService,
		@IProductService private readonly productService: IProductService
	) {
		super(logService);
	}

	protected retainOrCreateTunnel(resolveRemoteAuthority: IAddress, remoteHost: string, remotePort: number, localPort?: number): Promise<RemoteTunnel> | undefined {
		const portMap = this._tunnels.get(remoteHost);
		const existing = portMap ? portMap.get(remotePort) : undefined;
		if (existing) {
			++existing.refcount;
			return existing.value;
		}

		if (this._tunnelProvider) {
			const tunnel = this._tunnelProvider.forwardPort({ remoteAddress: { host: remoteHost, port: remotePort }, localAddressPort: localPort });
			if (tunnel) {
				this.addTunnelToMap(remoteHost, remotePort, tunnel);
			}
			return tunnel;
		} else {
			const options: IConnectionOptions = {
				commit: this.productService.commit,
				socketFactory: nodeSocketFactory,
				addressProvider: {
					getAddress: async () => {
						return resolveRemoteAuthority;
					}
				},
				signService: this.signService,
				logService: this.logService
			};

			const tunnel = createRemoteTunnel(options, remoteHost, remotePort, localPort);
			this.addTunnelToMap(remoteHost, remotePort, tunnel);
			return tunnel;
		}
	}
}
