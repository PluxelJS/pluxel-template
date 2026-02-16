export { CmdError, kindOfCmdErrorCode, toCmdError } from './core'
export type {
	CmdErrorCode,
	CmdErrorKind,
	CmdErrorDetails,
	CustomValidator,
	ExecCtx,
	Infer,
	Interceptor,
	JsonSchema,
	Schema,
	StrictEmptyObject,
	ValidationIssue,
} from './core'
export { issue, toJsonSchema } from './core'

export { Type, TypeBox, obj, openObj } from './typebox'
export type { Static, TSchema, TAnySchema, TProperties } from './typebox'

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
	McpToolDef,
	McpOp,
	McpExecutable,
	TextConfig,
	McpConfig,
	McpMeta,
	Ok,
	Op,
	ParamSpec,
	Result,
	TextMcpOp,
	TextOp,
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
	resolveMcpToolDef,
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
	TextRoutable,
} from './router'
export type { TextToken } from './tokenize'

export { textTail } from './text-tail'
export type { InferTextTail, TextTail } from './text-tail'

export { CMD_EVENT } from './events'
export type { CmdEvent } from './events'
