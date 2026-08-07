/**
 * Janitor control protocol: newline-delimited JSON over a unix domain socket
 * (docs/pi-guard-startup-flow.md §20).
 *
 * Shared by the launcher (client), the guard extension (client) and the
 * janitor (server). Message shapes live in src/types.ts.
 */

import { connect, type Socket } from "node:net";
import { JANITOR_PROTOCOL_VERSION, type JanitorMessage } from "./types.ts";

export { JANITOR_PROTOCOL_VERSION };

export function encodeMessage(message: JanitorMessage): string {
	return `${JSON.stringify(message)}\n`;
}

export function decodeMessage(line: string): JanitorMessage | undefined {
	try {
		const parsed = JSON.parse(line) as JanitorMessage;
		if (typeof parsed !== "object" || parsed === null || typeof parsed.type !== "string") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

export interface ProtocolClient {
	socket: Socket;
	/** Send a message. Returns false when the socket is already closed. */
	send(message: JanitorMessage): boolean;
	/** Register a listener for a specific message type. */
	on<T extends JanitorMessage["type"]>(type: T, handler: (msg: Extract<JanitorMessage, { type: T }>) => void): void;
	/** Wait for a message of a specific type (with optional timeout). */
	waitFor<T extends JanitorMessage["type"]>(
		type: T,
		timeoutMs?: number,
	): Promise<Extract<JanitorMessage, { type: T }> | undefined>;
	close(): void;
}

/**
 * Connect to the janitor control socket. Messages that arrive before a
 * listener is registered (e.g. READY right after connect) are buffered and
 * served to later waitFor() calls, so no handshake message is ever lost.
 */
export function connectToJanitor(socketPath: string, timeoutMs = 2000): Promise<ProtocolClient> {
	return new Promise((resolve, reject) => {
		const socket = connect(socketPath);
		const listeners = new Map<string, Array<(msg: never) => void>>();
		const pending: JanitorMessage[] = [];

		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (!line.trim()) continue;
				const message = decodeMessage(line);
				if (!message) continue;
				const handlers = listeners.get(message.type);
				if (handlers && handlers.length > 0) {
					for (const handler of [...handlers]) {
						try {
							handler(message as never);
						} catch {
							// listener errors never break the socket loop
						}
					}
				} else {
					pending.push(message);
				}
			}
		});

		const client: ProtocolClient = {
			socket,
			send(message) {
				if (socket.destroyed) return false;
				socket.write(encodeMessage(message));
				return true;
			},
			on(type, handler) {
				const list = listeners.get(type) ?? [];
				list.push(handler as (msg: never) => void);
				listeners.set(type, list);
			},
			waitFor(type, waitMs) {
				return new Promise((res) => {
					// Serve a buffered message first (covers the READY race).
					const idx = pending.findIndex((m) => m.type === type);
					if (idx >= 0) {
						const message = pending.splice(idx, 1)[0] as Extract<JanitorMessage, { type: typeof type }>;
						res(message);
						return;
					}
					let timer: NodeJS.Timeout | undefined;
					const handler = (msg: Extract<JanitorMessage, { type: typeof type }>): void => {
						const list = listeners.get(type) ?? [];
						const i = list.indexOf(handler as (msg: never) => void);
						if (i >= 0) list.splice(i, 1);
						if (timer) clearTimeout(timer);
						res(msg);
					};
					client.on(type, handler);
					if (waitMs !== undefined) {
						timer = setTimeout(() => {
							const list = listeners.get(type) ?? [];
							const i = list.indexOf(handler as (msg: never) => void);
							if (i >= 0) list.splice(i, 1);
							res(undefined);
						}, waitMs);
					}
				});
			},
			close() {
				socket.destroy();
			},
		};

		socket.once("connect", () => resolve(client));
		socket.once("error", (err) => reject(err));
	});
}
