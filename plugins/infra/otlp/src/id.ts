export function randomHex(bytes: number): string {
	try {
		const buf = new Uint8Array(bytes)
		crypto.getRandomValues(buf)
		return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
	} catch {
		let out = ''
		for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
		return out
	}
}

