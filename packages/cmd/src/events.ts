export const CMD_EVENT = {
	EXEC_START: 'cmd.exec.start',
	EXEC_END: 'cmd.exec.end',
	EXEC_ERROR: 'cmd.exec.error',
	EXEC_RECOVERED: 'cmd.exec.recovered',
	EXEC_FAULT: 'cmd.exec.fault',

	SCHEMA_INPUT_START: 'cmd.schema.input.start',
	SCHEMA_INPUT_OK: 'cmd.schema.input.ok',
	SCHEMA_INPUT_FAIL: 'cmd.schema.input.fail',

	SCHEMA_OUTPUT_START: 'cmd.schema.output.start',
	SCHEMA_OUTPUT_OK: 'cmd.schema.output.ok',
	SCHEMA_OUTPUT_FAIL: 'cmd.schema.output.fail',
} as const

export type CmdEvent = (typeof CMD_EVENT)[keyof typeof CMD_EVENT]
