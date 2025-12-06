import { BasePlugin, Plugin } from '@pluxel/hmr'
import WS, { type RawData, type ClientOptions as WSClientOptions } from 'ws'

const DISPOSE: unique symbol = (Symbol as any).dispose ?? Symbol.for('Symbol.dispose')
const ASYNC_DISPOSE: unique symbol =
	(Symbol as any).asyncDispose ?? Symbol.for('Symbol.asyncDispose')

type NodeWebSocket = WS & { off?: WS['off'] }
type BrowserWebSocket = ReturnType<typeof createBrowserSocketAdapter>

export type WebSocketLike = NodeWebSocket | BrowserWebSocket
export type WebSocketData = RawData | ArrayBuffer | ArrayBufferView | Blob | string
export type WebSocketClientOptions = WSClientOptions

export const WSReadyState = {
	CONNECTING: 0,
	OPEN: 1,
	CLOSING: 2,
	CLOSED: 3,
} as const

export interface ManagedWebSocket {
	socket: WebSocketLike
	close: (code?: number, reason?: string) => void
	[DISPOSE]?: () => void
	[ASYNC_DISPOSE]?: () => Promise<void>
}

export interface ConnectOptions {
	protocols?: string | string[]
	clientOptions?: WSClientOptions
	description?: string
	/** 默认 true：注册到 caller scope，卸载时自动释放 */
	trackToCaller?: boolean
	/** 默认 true：插件停止时会关闭该连接 */
	closeOnStop?: boolean
}

export type WebSocketFactory = (url: string, options?: ConnectOptions) => ManagedWebSocket

type ManagedRecord = {
	socket: WebSocketLike
	description?: string
	closed: boolean
}

@Plugin({ name: 'WebSocket', type: 'service' })
export class WebSocketPlugin extends BasePlugin {
	private readonly managed = new Set<ManagedRecord>()

	init(): void {
		this.ctx.logger.info('WebSocketPlugin ready')
	}

	async stop(): Promise<void> {
		for (const rec of [...this.managed]) {
			this.safeClose(rec, 1001, 'plugin stopped')
		}
		this.managed.clear()
	}

	connect(url: string, options: ConnectOptions = {}): ManagedWebSocket {
		const useNative =
			typeof globalThis !== 'undefined' &&
			typeof (globalThis as any).WebSocket === 'function' &&
			// ws/browser 入口会提示使用原生 WebSocket，这里优先选原生
			!!(globalThis as any).WebSocket

		const socket = useNative
			? createBrowserSocketAdapter(
					new (globalThis as any).WebSocket(url, options.protocols as any),
					options.description ?? url,
				)
			: (new WS(url, options.protocols as any, {
					perMessageDeflate: false,
					...options.clientOptions,
				}) as NodeWebSocket)

		return this.adopt(socket, { ...options, description: options.description ?? url })
	}

	adopt(socket: WebSocketLike, options: ConnectOptions = {}): ManagedWebSocket {
		const record: ManagedRecord = {
			socket,
			description: options.description ?? socket.url ?? 'ws',
			closed: false,
		}
		const cleanup = () => this.safeClose(record)
		const trackCaller = options.trackToCaller ?? true

		// 收集到 caller scope，方便依赖方卸载时自动清理
		if (trackCaller) {
			this.ctx.caller?.scope?.collectEffect?.(cleanup)
		}
		// 也收集到自身 scope，插件停止时兜底清理
		this.ctx.scope.collectEffect(cleanup)

		if (options.closeOnStop ?? true) {
			this.managed.add(record)
		}

		if (typeof (socket as any).once === 'function') {
			;(socket as any).once('close', () => cleanup())
		} else if (typeof (socket as any).addEventListener === 'function') {
			;(socket as any).addEventListener('close', () => cleanup(), { once: true } as any)
		}

		const cleanupWithReason = (code?: number, reason?: string) => {
			if (record.closed) return
			this.safeClose(record, code, reason)
		}

		const handle: ManagedWebSocket = {
			socket,
			close: cleanupWithReason,
		}

		;(handle as any)[DISPOSE] = cleanupWithReason
		;(handle as any)[ASYNC_DISPOSE] = async () => cleanupWithReason()

		return handle
	}

	private safeClose(record: ManagedRecord, code?: number, reason?: string) {
		if (record.closed) return
		record.closed = true
		this.managed.delete(record)
		try {
			record.socket.close(code, reason)
		} catch (err) {
			this.ctx.logger.debug(err, `WS close failed: ${record.description}`)
		}
		try {
			record.socket.removeAllListeners?.()
		} catch {}
		try {
			if (typeof record.socket.terminate === 'function') {
				record.socket.terminate()
			}
		} catch {}
	}
}

export type { RawData }

type Listener = (...args: any[]) => void

function createBrowserSocketAdapter(socket: any, desc?: string) {
	const listeners = new Map<string, Set<Listener>>()

	const emit = (event: string, ...args: any[]) => {
		const set = listeners.get(event)
		if (!set) return
		for (const fn of Array.from(set)) {
			try {
				fn(...args)
			} catch {}
		}
	}

	const on = (event: string, fn: Listener) => {
		let set = listeners.get(event)
		if (!set) {
			set = new Set()
			listeners.set(event, set)
		}
		set.add(fn)
		return adapter
	}

	const off = (event: string, fn: Listener) => {
		listeners.get(event)?.delete(fn)
		return adapter
	}

	const once = (event: string, fn: Listener) => {
		const wrap: Listener = (...args: any[]) => {
			off(event, wrap)
			fn(...args)
		}
		return on(event, wrap)
	}

	socket.addEventListener('message', (ev) => emit('message', ev.data))
	socket.addEventListener('close', (ev) => emit('close', ev.code, ev.reason))
	socket.addEventListener('error', (ev) => emit('error', ev))
	socket.addEventListener('open', () => emit('open'))

	const adapter = {
		url: socket.url || desc,
		get readyState() {
			return socket.readyState
		},
		on,
		off,
		once,
		removeAllListeners: () => listeners.clear(),
		send: (data: any) => socket.send(data as any),
		close: (code?: number, reason?: string) => socket.close(code, reason),
		terminate: () => socket.close(),
	} as BrowserWebSocket

	return adapter
}
