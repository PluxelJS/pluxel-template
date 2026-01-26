import {
	rapidhash as rapidhashImpl,
	rapidhash_fast as rapidhashFastImpl,
	rapidhash_protected as rapidhashProtectedImpl,
} from 'rapidhash-js'

export const rapidhash = rapidhashImpl
export const rapidhash_fast = rapidhashFastImpl
export const rapidhash_protected = rapidhashProtectedImpl

export function rapidHash64Hex(message: string | Uint8Array | DataView): string {
	const value = rapidhashImpl(message)
	return value.toString(16).padStart(16, '0')
}
