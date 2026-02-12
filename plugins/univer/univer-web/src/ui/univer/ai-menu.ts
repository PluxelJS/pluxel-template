import { CommandType, type IDisposable, type Univer as UniverCtor } from '@univerjs/core'
import { ICommandService } from '@univerjs/core'
import { IMenuManagerService, MenuItemType, type MenuSchemaType } from '@univerjs/ui'

import type { FUniver } from '@univerjs/core/facade'

import { collectActiveSelectionContexts } from '../ai/univer-bridge'
import { pinUniverAiSelections, clearUniverAiSelections } from '../ai/context-store'
import {
	addUniverAiReadScopeFromSelections,
	limitUniverAiReadScopeToSelections,
	resetUniverAiReadScopeToWorkbook,
	resetUniverAiReadScopeToSheet,
} from '../ai/read-scope-store'
import {
	allowUniverAiWriteScopeToSheet,
	allowUniverAiWriteScopeToWorkbook,
	addUniverAiWriteScopeFromSelections,
	disableUniverAiWriteScope,
	limitUniverAiWriteScopeToSelections,
} from '../ai/write-scope-store'

const AI_MENU_ROOT_ID = 'pluxel.ai.menu'
const AI_OPEN_COMMAND_ID = 'pluxel.ai.open'
const AI_ADD_CONTEXT_COMMAND_ID = 'pluxel.ai.context.addSelection'
const AI_CLEAR_CONTEXT_COMMAND_ID = 'pluxel.ai.context.clear'
const AI_READ_LIMIT_COMMAND_ID = 'pluxel.ai.readScope.limitToSelection'
const AI_READ_ADD_COMMAND_ID = 'pluxel.ai.readScope.addSelection'
const AI_READ_RESET_COMMAND_ID = 'pluxel.ai.readScope.resetToSheet'
const AI_READ_RESET_WORKBOOK_COMMAND_ID = 'pluxel.ai.readScope.resetToWorkbook'
const AI_WRITE_LIMIT_COMMAND_ID = 'pluxel.ai.writeScope.limitToSelection'
const AI_WRITE_ADD_COMMAND_ID = 'pluxel.ai.writeScope.addSelection'
const AI_WRITE_ALLOW_SHEET_COMMAND_ID = 'pluxel.ai.writeScope.allowSheet'
const AI_WRITE_ALLOW_WORKBOOK_COMMAND_ID = 'pluxel.ai.writeScope.allowWorkbook'
const AI_WRITE_DISABLE_COMMAND_ID = 'pluxel.ai.writeScope.disable'

const DEFAULT_LIMITS = { maxRows: 40, maxCols: 16 } as const

function createAiMenuItem() {
	return {
		id: AI_OPEN_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: 'AI',
		tooltip: 'AI',
		commandId: AI_OPEN_COMMAND_ID,
	}
}

function createAiSubmenuRootItem() {
	return {
		id: AI_MENU_ROOT_ID,
		type: MenuItemType.SUBITEMS,
		title: 'AI',
		tooltip: 'AI',
	}
}

function createAddToContextMenuItem() {
	return {
		id: AI_ADD_CONTEXT_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '添加到 AI 情境',
		tooltip: '添加当前选区（含 Ctrl 多选）到 AI 情境',
		commandId: AI_ADD_CONTEXT_COMMAND_ID,
	}
}

function createClearContextMenuItem() {
	return {
		id: AI_CLEAR_CONTEXT_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '清空 AI 情境',
		tooltip: '清空 AI 情境',
		commandId: AI_CLEAR_CONTEXT_COMMAND_ID,
	}
}

function createWriteLimitMenuItem() {
	return {
		id: AI_WRITE_LIMIT_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '写入权限：限制为选区',
		tooltip: '仅允许 AI 写入当前选区（含 Ctrl 多选）',
		commandId: AI_WRITE_LIMIT_COMMAND_ID,
	}
}

function createWriteAddMenuItem() {
	return {
		id: AI_WRITE_ADD_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '写入权限：添加选区',
		tooltip: '将当前选区追加到写入权限限制（可在多个工作表重复执行以跨表授权）',
		commandId: AI_WRITE_ADD_COMMAND_ID,
	}
}

function createWriteAllowSheetMenuItem() {
	return {
		id: AI_WRITE_ALLOW_SHEET_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '写入权限：允许整表',
		tooltip: '允许 AI 写入当前工作表（整表可写）',
		commandId: AI_WRITE_ALLOW_SHEET_COMMAND_ID,
	}
}

function createWriteAllowWorkbookMenuItem() {
	return {
		id: AI_WRITE_ALLOW_WORKBOOK_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '写入权限：允许工作簿',
		tooltip: '允许 AI 写入整个工作簿（所有工作表；高风险）',
		commandId: AI_WRITE_ALLOW_WORKBOOK_COMMAND_ID,
	}
}

function createWriteDisableMenuItem() {
	return {
		id: AI_WRITE_DISABLE_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '写入权限：只读（关闭写入）',
		tooltip: '禁止 AI 写入（只允许读取/搜索）',
		commandId: AI_WRITE_DISABLE_COMMAND_ID,
	}
}

function createReadLimitMenuItem() {
	return {
		id: AI_READ_LIMIT_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '读取范围：限制为选区',
		tooltip: '仅允许 AI 读取当前选区（含 Ctrl 多选）',
		commandId: AI_READ_LIMIT_COMMAND_ID,
	}
}

function createReadAddMenuItem() {
	return {
		id: AI_READ_ADD_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '读取范围：添加选区',
		tooltip: '将当前选区追加到读取范围限制（可在多个工作表重复执行以跨表授权）',
		commandId: AI_READ_ADD_COMMAND_ID,
	}
}

function createReadResetMenuItem() {
	return {
		id: AI_READ_RESET_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '读取范围：恢复整表',
		tooltip: '恢复为整表可读（不限制读取范围）',
		commandId: AI_READ_RESET_COMMAND_ID,
	}
}

function createReadResetWorkbookMenuItem() {
	return {
		id: AI_READ_RESET_WORKBOOK_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '读取范围：恢复工作簿',
		tooltip: '允许读取整个工作簿（所有工作表）',
		commandId: AI_READ_RESET_WORKBOOK_COMMAND_ID,
	}
}

export function registerAiMenu(
	univer: UniverCtor,
	input: { api: FUniver; workbookId: string; onOpen: () => void },
): IDisposable | null {
	const injector = univer.__getInjector()
	const commandService = injector.get(ICommandService)
	const menuManager = injector.get(IMenuManagerService)

	const commandDisposables: IDisposable[] = []

	if (!commandService.hasCommand(AI_OPEN_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_OPEN_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_ADD_CONTEXT_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_ADD_CONTEXT_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					const res = collectActiveSelectionContexts({ api: input.api, workbookId: input.workbookId, limits: DEFAULT_LIMITS })
					if (res?.current) {
						pinUniverAiSelections(input.workbookId, [res.current, ...res.selections])
						input.onOpen()
						return true
					}
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_CLEAR_CONTEXT_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_CLEAR_CONTEXT_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					clearUniverAiSelections(input.workbookId)
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_WRITE_LIMIT_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_WRITE_LIMIT_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					const res = collectActiveSelectionContexts({ api: input.api, workbookId: input.workbookId, limits: DEFAULT_LIMITS })
					if (res?.current) {
						limitUniverAiWriteScopeToSelections(input.workbookId, [res.current, ...res.selections])
					}
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_WRITE_ADD_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_WRITE_ADD_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					const res = collectActiveSelectionContexts({ api: input.api, workbookId: input.workbookId, limits: DEFAULT_LIMITS })
					if (res?.current) {
						addUniverAiWriteScopeFromSelections(input.workbookId, [res.current, ...res.selections])
					}
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_WRITE_ALLOW_SHEET_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_WRITE_ALLOW_SHEET_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					allowUniverAiWriteScopeToSheet(input.workbookId)
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_WRITE_ALLOW_WORKBOOK_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_WRITE_ALLOW_WORKBOOK_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					allowUniverAiWriteScopeToWorkbook(input.workbookId)
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_WRITE_DISABLE_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_WRITE_DISABLE_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					disableUniverAiWriteScope(input.workbookId)
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_READ_LIMIT_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_READ_LIMIT_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					const res = collectActiveSelectionContexts({ api: input.api, workbookId: input.workbookId, limits: DEFAULT_LIMITS })
					if (res?.current) {
						limitUniverAiReadScopeToSelections(input.workbookId, [res.current, ...res.selections])
					}
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_READ_ADD_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_READ_ADD_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					const res = collectActiveSelectionContexts({ api: input.api, workbookId: input.workbookId, limits: DEFAULT_LIMITS })
					if (res?.current) {
						addUniverAiReadScopeFromSelections(input.workbookId, [res.current, ...res.selections])
					}
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_READ_RESET_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_READ_RESET_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					resetUniverAiReadScopeToSheet(input.workbookId)
					input.onOpen()
					return true
				},
			}),
		)
	}

	if (!commandService.hasCommand(AI_READ_RESET_WORKBOOK_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_READ_RESET_WORKBOOK_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					resetUniverAiReadScopeToWorkbook(input.workbookId)
					input.onOpen()
					return true
				},
			}),
		)
	}

	const menuSchema: MenuSchemaType = {
		'ribbon.start': {
			'ribbon.start.others': {
				[AI_OPEN_COMMAND_ID]: {
					order: 1,
					menuItemFactory: () => createAiMenuItem(),
				},
			},
		},
		'contextMenu.mainArea': {
			'contextMenu.others': {
				[AI_MENU_ROOT_ID]: {
					order: 0,
					menuItemFactory: () => createAiSubmenuRootItem(),
						[`${AI_MENU_ROOT_ID}-group-0`]: {
							[AI_OPEN_COMMAND_ID]: {
								order: 0,
								menuItemFactory: () => createAiMenuItem(),
							},
							[AI_ADD_CONTEXT_COMMAND_ID]: {
								order: 1,
								menuItemFactory: () => createAddToContextMenuItem(),
							},
							[AI_CLEAR_CONTEXT_COMMAND_ID]: {
								order: 2,
								menuItemFactory: () => createClearContextMenuItem(),
							},
						},
						[`${AI_MENU_ROOT_ID}-group-1`]: {
							[AI_READ_LIMIT_COMMAND_ID]: {
								order: 0,
								menuItemFactory: () => createReadLimitMenuItem(),
							},
							[AI_READ_ADD_COMMAND_ID]: {
								order: 1,
								menuItemFactory: () => createReadAddMenuItem(),
							},
							[AI_READ_RESET_COMMAND_ID]: {
								order: 2,
								menuItemFactory: () => createReadResetMenuItem(),
							},
							[AI_READ_RESET_WORKBOOK_COMMAND_ID]: {
								order: 3,
								menuItemFactory: () => createReadResetWorkbookMenuItem(),
							},
						},
						[`${AI_MENU_ROOT_ID}-group-2`]: {
							[AI_WRITE_DISABLE_COMMAND_ID]: {
								order: 0,
								menuItemFactory: () => createWriteDisableMenuItem(),
							},
							[AI_WRITE_ALLOW_SHEET_COMMAND_ID]: {
								order: 1,
								menuItemFactory: () => createWriteAllowSheetMenuItem(),
							},
							[AI_WRITE_ALLOW_WORKBOOK_COMMAND_ID]: {
								order: 2,
								menuItemFactory: () => createWriteAllowWorkbookMenuItem(),
							},
							[AI_WRITE_LIMIT_COMMAND_ID]: {
								order: 3,
								menuItemFactory: () => createWriteLimitMenuItem(),
							},
							[AI_WRITE_ADD_COMMAND_ID]: {
								order: 4,
								menuItemFactory: () => createWriteAddMenuItem(),
							},
						},
					},
				},
			},
		}

	menuManager.mergeMenu(menuSchema)

	if (!commandDisposables.length) return null
	return {
		dispose() {
			for (const d of commandDisposables) d.dispose()
		},
	}
}
