// Public surface: keep one canonical command-definition DSL (command/op/defs/group/when)
// and one canonical install/runtime entry (Cmd.createSpace()).
//
// Low-level building blocks (cmd/createRouter/createCommandKit/...) remain available to this
// package's internal tests via relative imports, but are intentionally not exported here.

import { createCommandSpace } from './space'
import { tail } from './tail'
import { Type, TypeBox, obj, openObj } from './typebox'
import { command, defs, group, op, when } from './kit/define'

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

export type { CmdDoc, CmdDocSource, DocContext, DocProvider, DocTextProvider, DocTextSource } from './doc'

export { tail } from './tail'
export type { TailPatch } from './tail'
export type { InferTextTail, TextTail } from './tail'

export type { ParamSpec } from './text'

export type { Err, Ok, Result } from './result'
export { createErr, createOk, expectErr, expectOk, isErr, isOk, unwrapErr, unwrapOk } from './result'

export { createCommandSpace } from './space'
export type { CommandScope, CommandSpace } from './space'
export type { CmdExt, RegisteredCommandInfo } from './registry'

export { command, op, defs, group, when } from './kit/define'
export type { CollectedCommandMeta, CommandDef, CommandDefInput, CommandBuilder, OpBuilder } from './kit/define'
export type { KitWithOptions } from './kit/spec'

export const Cmd = {
	createSpace: createCommandSpace,
	command,
	op,
	defs,
	group,
	when,
	Type,
	TypeBox,
	obj,
	openObj,
	tail,
} as const
