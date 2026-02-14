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
	TextConfig,
	McpConfig,
	McpExecutable,
	McpMeta,
	Ok,
	ParamSpec,
	Result,
	TextExecutable,
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
export type { TextToken } from './tokenize'

export { textTail } from './text-tail'
export type { InferTextTail, TextTail } from './text-tail'

export { CMD_EVENT } from './events'
export type { CmdEvent } from './events'
