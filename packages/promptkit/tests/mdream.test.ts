import { describe, expect, it } from 'vitest'

describe('@pluxel/promptkit/mdream', () => {
	it('converts simple HTML to markdown', async () => {
		const { htmlToMarkdown } = await import('@pluxel/promptkit/mdream')
		const md = await htmlToMarkdown('<h1>Hello</h1><p>World</p>')
		expect(md).toContain('Hello')
		expect(md).toContain('World')
	})
})

