export type ProviderPreset = Readonly<{
	id: string
	label: string
	provider: string
	baseURL?: string
	modelHint?: string
	note?: string
}>

export const DEFAULT_PROVIDER_PRESETS: ProviderPreset[] = [
	{
		id: 'openai',
		label: 'OpenAI',
		provider: 'openai',
		baseURL: 'https://api.openai.com/v1',
		modelHint: 'gpt-4o-mini',
	},
	{
		id: 'deepseek',
		label: 'DeepSeek (OpenAI-compatible)',
		provider: 'deepseek',
		baseURL: 'https://api.deepseek.com',
		modelHint: 'deepseek-chat',
	},
	{
		id: 'mistral',
		label: 'Mistral (OpenAI-compatible)',
		provider: 'mistral',
		baseURL: 'https://api.mistral.ai/v1',
		modelHint: 'mistral-large-latest',
	},
	{
		id: 'groq',
		label: 'Groq (OpenAI-compatible)',
		provider: 'groq',
		baseURL: 'https://api.groq.com/openai/v1',
		modelHint: 'llama-3.3-70b-versatile',
	},
	{
		id: 'openrouter',
		label: 'OpenRouter (OpenAI-compatible)',
		provider: 'openrouter',
		baseURL: 'https://openrouter.ai/api/v1',
		modelHint: 'openai/gpt-4o-mini',
	},
	{
		id: 'together',
		label: 'Together (OpenAI-compatible)',
		provider: 'together',
		baseURL: 'https://api.together.xyz/v1',
		modelHint: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo',
	},
	{
		id: 'anthropic',
		label: 'Anthropic',
		provider: 'anthropic',
		modelHint: 'claude-3-5-sonnet-latest',
		note: 'Anthropic API 非 OpenAI 兼容；如需自动拉取 models，请在 Advanced 配置 modelListPath（若你的代理支持）或保持关闭。',
	},
	{
		id: 'google',
		label: 'Google Gemini',
		provider: 'google',
		modelHint: 'gemini-1.5-pro',
		note: 'Gemini API 非 OpenAI 兼容，请手动填写模型名并按需配置 baseURL。',
	},
	{
		id: 'cohere',
		label: 'Cohere',
		provider: 'cohere',
		modelHint: 'command-r-plus',
		note: 'Cohere API 非 OpenAI 兼容，请手动填写模型名并按需配置 baseURL。',
	},
	{
		id: 'qwen',
		label: 'Qwen (DashScope)',
		provider: 'qwen',
		modelHint: 'qwen-max',
		note: 'DashScope 非 OpenAI 兼容，请手动填写模型名并按需配置 baseURL。',
	},
	{
		id: 'zhipu',
		label: 'Zhipu',
		provider: 'zhipu',
		modelHint: 'glm-4',
		note: '智谱 API 非 OpenAI 兼容，请手动填写模型名并按需配置 baseURL。',
	},
	{
		id: 'moonshot',
		label: 'Moonshot',
		provider: 'moonshot',
		modelHint: 'moonshot-v1-8k',
		note: 'Moonshot API 配置差异较多，建议手动填写模型名与 baseURL。',
	},
	{
		id: 'custom',
		label: 'Other / Custom',
		provider: 'custom',
	},
]

export const PRESET_OPTIONS = DEFAULT_PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label }))

export function resolvePreset(id: string | null): ProviderPreset {
	return DEFAULT_PROVIDER_PRESETS.find((p) => p.id === id) ?? DEFAULT_PROVIDER_PRESETS[DEFAULT_PROVIDER_PRESETS.length - 1]
}

