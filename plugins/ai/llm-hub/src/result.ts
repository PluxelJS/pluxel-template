export type Result<T, E> =
	| { ok: true; val: T; err: null }
	| { ok: false; val: null; err: E }

export function ok<T>(val: T): Result<T, never> {
	return { ok: true, val, err: null }
}

export function err<E>(e: E): Result<never, E> {
	return { ok: false, val: null, err: e }
}

