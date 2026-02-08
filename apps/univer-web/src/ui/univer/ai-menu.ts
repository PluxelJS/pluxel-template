import { CommandType, type IDisposable, type Univer as UniverCtor } from '@univerjs/core'
import { ICommandService } from '@univerjs/core'
import { IMenuManagerService, MenuItemType, type MenuSchemaType } from '@univerjs/ui'

const AI_COMMAND_ID = 'pluxel.ai.open'

function createAiMenuItem() {
	return {
		id: AI_COMMAND_ID,
		type: MenuItemType.BUTTON,
		title: 'AI',
		tooltip: 'AI',
		commandId: AI_COMMAND_ID,
	}
}

export function registerAiMenu(univer: UniverCtor, onOpen: () => void): IDisposable | null {
	const injector = univer.__getInjector()
	const commandService = injector.get(ICommandService)
	const menuManager = injector.get(IMenuManagerService)

	let commandDisposable: IDisposable | null = null
	if (!commandService.hasCommand(AI_COMMAND_ID)) {
		commandDisposable = commandService.registerCommand({
			id: AI_COMMAND_ID,
			type: CommandType.OPERATION,
			handler: () => {
				onOpen()
				return true
			},
		})
	}

	const menuSchema: MenuSchemaType = {
		'ribbon.start': {
			'ribbon.start.others': {
				[AI_COMMAND_ID]: {
					order: 1,
					menuItemFactory: () => createAiMenuItem(),
				},
			},
		},
		'contextMenu.mainArea': {
			'contextMenu.others': {
				[AI_COMMAND_ID]: {
					order: 0,
					menuItemFactory: () => createAiMenuItem(),
				},
			},
		},
	}

	menuManager.mergeMenu(menuSchema)

	return commandDisposable
}
