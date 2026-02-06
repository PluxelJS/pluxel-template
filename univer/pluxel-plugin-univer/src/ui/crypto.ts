export async function sha256Hex(buf: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', buf as unknown as BufferSource)
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

