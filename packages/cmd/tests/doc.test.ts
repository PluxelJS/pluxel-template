import { describe, expect, it } from 'vitest'

import { mergeDocSources, resolveDoc } from '../src/doc'

describe('cmdkit: doc()', () => {
	it('mergeDocSources() merges object docs (including new structured fields)', () => {
		const merged = mergeDocSources(
			{ description: 'A', usage: 'a <x>', examples: ['a 1'] },
			{ description: 'B', details: 'More', examples: ['a 2'] },
		)

		expect(resolveDoc(merged, {})).toEqual({
			description: 'B',
			usage: 'a <x>',
			details: 'More',
			examples: ['a 2'],
		})
	})

	it('mergeDocSources() merges providers by ctx', () => {
		const merged = mergeDocSources(
			(ctx) => ({ description: String(ctx.locale), examples: ['x'] }),
			(ctx) => ({ description: `d:${String(ctx.locale)}`, usage: 'u', examples: ['y'] }),
		)

		expect(resolveDoc(merged, { locale: 'en-US' })).toEqual({
			description: 'd:en-US',
			usage: 'u',
			examples: ['y'],
		})
	})
})

