import type { AxFunction } from '@ax-llm/ax'

export const asAxParams = (schema: unknown) => schema as unknown as AxFunction['parameters']

