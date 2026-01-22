export { CmdError, kindOfCmdErrorCode, toCmdError } from './core'
export type {
	AnyStdSchema,
	CmdErrorCode,
	CmdErrorKind,
	CmdErrorDetails,
	ExecCtx,
	Interceptor,
	StrictEmptyObject,
	VSchema,
	ValidationIssue,
} from './core'

export { cmd } from './cmd'
export type {
	ArgvAdapter,
	CmdBuilder,
	CmdDoc,
	CmdDocSource,
	DocContext,
	DocTextProvider,
	DocTextSource,
	DocProvider,
	Err,
	Executable,
	ExecutableMeta,
	McpConfig,
	McpExecutable,
	McpMeta,
	Ok,
	Result,
	TextExecutable,
	TextConfig,
	TextMapFn,
} from './cmd'
export {
	ResultOperator,
	createErr,
	createOk,
	expectErr,
	expectOk,
	isErr,
	isExecutable,
	isMcpExecutable,
	isOk,
	isTextExecutable,
	resolveDoc,
	resolveText,
	unwrapErr,
	unwrapOk,
} from './cmd'

export { createRouter } from './router'
export { defaultTokenizer } from './tokenize'
export type {
	Router,
	RouterEntry,
	RouterHelpCommandResult,
	RouterHelpIndexResult,
	RouterIssue,
	RouterMatch,
} from './router'
export type { TextTokenizer } from './tokenize'

export { CMD_EVENT } from './events'
export type { CmdEvent } from './events'

export { createTypeFlagAdapter } from './argv/type-flag'
export type { FlagSpec, ParsedArgv } from './argv/types'
