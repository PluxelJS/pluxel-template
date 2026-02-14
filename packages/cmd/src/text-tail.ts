import type { Runtime } from '@sinclair/parsebox'

export type TextTail<
	Properties extends Runtime.IProperties = Runtime.IProperties,
	Entry extends keyof Properties = keyof Properties,
> = {
	module: Runtime.Module<Properties>
	entry: Entry
}

type OutputOfParser<P> = P extends Runtime.IParser<infer Output> ? Output : unknown

export type InferTextTail<T extends TextTail> = T extends TextTail<infer Properties, infer Entry>
	? OutputOfParser<Properties[Entry]>
	: unknown

export function textTail<Properties extends Runtime.IProperties, Entry extends keyof Properties>(
	module: Runtime.Module<Properties>,
	entry: Entry,
): TextTail<Properties, Entry> {
	return { module, entry }
}
