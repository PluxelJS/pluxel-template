import { CommandType, type IDisposable, type Univer as UniverCtor } from '@univerjs/core'
import { ICommandService } from '@univerjs/core'
import { IMenuManagerService, MenuItemType, type MenuSchemaType } from '@univerjs/ui'

import type { FUniver } from '@univerjs/core/facade'

import { collectActiveSelectionContexts } from '../ai/univer-bridge'
import { pinUniverAiSelections, clearUniverAiSelections } from '../ai/context-store'
import {
	limitUniverAiWriteScopeToSelections,
	resetUniverAiWriteScopeToSheet,
} from '../ai/write-scope-store'

const AI_MENU_ROOT_ID = 'pluxel.ai.menu'
const AI_OPEN_COMMAND_ID = 'pluxel.ai.open'
const AI_ADD_CONTEXT_COMMAND_ID = 'pluxel.ai.context.addSelection'
const AI_CLEAR_CONTEXT_COMMAND_ID = 'pluxel.ai.context.clear'
const AI_WRITE_LIMIT_COMMAND_ID = 'pluxel.ai.writeScope.limitToSelection'
const AI_WRITE_RESET_COMMAND_ID = 'pluxel.ai.writeScope.resetToSheet'

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
		title: '写入范围：限制为选区',
		tooltip: '将 AI 写入限制为当前选区（含 Ctrl 多选）',
		commandId: AI_WRITE_LIMIT_COMMAND_ID,
	}
}

function createWriteResetMenuItem() {
	return {
		id: AI_WRITE_RESET_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: '写入范围：恢复整表',
		tooltip: '恢复为整表可写（不限制写入范围）',
		commandId: AI_WRITE_RESET_COMMAND_ID,
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

	if (!commandService.hasCommand(AI_WRITE_RESET_COMMAND_ID)) {
		commandDisposables.push(
			commandService.registerCommand({
				id: AI_WRITE_RESET_COMMAND_ID,
				type: CommandType.OPERATION,
				handler: () => {
					resetUniverAiWriteScopeToSheet(input.workbookId)
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
						[AI_WRITE_LIMIT_COMMAND_ID]: {
							order: 0,
							menuItemFactory: () => createWriteLimitMenuItem(),
						},
						[AI_WRITE_RESET_COMMAND_ID]: {
							order: 1,
							menuItemFactory: () => createWriteResetMenuItem(),
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
