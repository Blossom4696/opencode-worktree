import { openSessionTerminal } from "./plugin/worktree/terminal"

type TuiSize = "small" | "medium" | "large"
type ToastVariant = "info" | "success" | "warning" | "error"

type SessionMessage = {
	id: string
	role: string
}

type TextPart = {
	type: "text"
	text: string
	synthetic?: boolean
	ignored?: boolean
}

type Part = TextPart | { type: string; [key: string]: unknown }

type SelectOption<Value> = {
	title: string
	value: Value
	description?: string
	footer?: string
	category?: string
	disabled?: boolean
	onSelect?: () => void | Promise<void>
}

type CommandOption = SelectOption<string> & {
	keybind?: string
	suggested?: boolean
	slash?: {
		name: string
		aliases?: string[]
	}
	enabled?: boolean
	hidden?: boolean
}

type SessionResponse = {
	data?: {
		id: string
	}
	error?: unknown
}

type TuiPluginApi = {
	command: {
		register: (cb: () => CommandOption[]) => (() => void) | void
	}
	route: {
		current: {
			name: string
			params?: Record<string, unknown>
		}
	}
	ui: {
		DialogSelect: <Value>(props: {
			title: string
			options: SelectOption<Value>[]
			onMove?: (item: SelectOption<Value>) => void
		}) => unknown
		dialog: {
			replace: (render: () => unknown, onClose?: () => void) => void
			clear: () => void
			setSize: (size: TuiSize) => void
		}
		toast: (input: { message: string; variant?: ToastVariant }) => void
	}
	state: {
		path: {
			directory?: string
		}
		session: {
			messages: (sessionID: string) => SessionMessage[]
		}
		part: (messageID: string) => Part[]
	}
	client: {
		session: {
			create: (input?: Record<string, unknown>) => Promise<SessionResponse>
			fork: (input: { sessionID: string; messageID?: string }) => Promise<SessionResponse>
		}
	}
}

type TuiPluginModule = {
	id: string
	tui: (api: TuiPluginApi) => Promise<void>
}

const id = "opencode-worktree"
const SESSION_COMMAND_CATEGORY = "Session"
const FORK_COMMAND_TITLE = "Fork from message in new tmux window"
const NEW_COMMAND_TITLE = "New session in new tmux window"

function currentSessionID(api: TuiPluginApi): string | undefined {
	if (api.route.current.name !== "session") return undefined
	const sessionID = api.route.current.params?.sessionID
	return typeof sessionID === "string" ? sessionID : undefined
}

function getForkableMessageOptions(api: TuiPluginApi, sessionID: string): SelectOption<string>[] {
	const options: SelectOption<string>[] = []
	const messages = api.state.session.messages(sessionID)

	for (const message of messages) {
		if (message.role !== "user") continue
		const textPart = api.state
			.part(message.id)
			.find((part): part is TextPart => part.type === "text" && !part.synthetic && !part.ignored)
		if (!textPart) continue

		const title = textPart.text.replace(/\n/g, " ").trim()
		if (!title) continue

		options.push({
			title,
			value: message.id,
		})
	}

	options.reverse()
	return options
}

function getLaunchDirectory(api: TuiPluginApi): string | undefined {
	const cwd = api.state.path.directory?.trim()
	if (cwd) return cwd
	api.ui.toast({ message: "当前目录不可用，无法在新窗口打开 session", variant: "error" })
	return undefined
}

async function openSpawnedSession(
	api: TuiPluginApi,
	cwd: string,
	result: SessionResponse,
	windowName: string,
	successMessage: string,
): Promise<void> {
	if (result.error || !result.data?.id) {
		const message = result.error instanceof Error ? result.error.message : "创建 session 失败"
		api.ui.toast({ message, variant: "error" })
		return
	}

	const openResult = await openSessionTerminal(cwd, result.data.id, windowName, {
		detachedInTmux: true,
	})
	if (!openResult.success) {
		api.ui.toast({
			message: `已创建 session ${result.data.id}，但打开终端失败：${openResult.error ?? "未知错误"}`,
			variant: "warning",
		})
		return
	}

	api.ui.toast({ message: successMessage, variant: "success" })
	api.ui.dialog.clear()
}

function showForkDialog(api: TuiPluginApi, sessionID: string) {
	const options = getForkableMessageOptions(api, sessionID)
	if (options.length === 0) {
		api.ui.toast({ message: "当前 session 没有可 fork 的用户文本消息", variant: "warning" })
		return
	}

	api.ui.dialog.replace(() => {
		api.ui.dialog.setSize("large")
		return api.ui.DialogSelect({
			title: FORK_COMMAND_TITLE,
			options: options.map((option) => ({
				...option,
				onSelect: async () => {
					const cwd = getLaunchDirectory(api)
					if (!cwd) return
					const result = await api.client.session.fork({
						sessionID,
						messageID: option.value,
					})
					await openSpawnedSession(
						api,
						cwd,
						result,
						result.data?.id ?? "fork",
						"已在新 tmux 窗口打开 fork session",
					)
				},
			})),
		})
	})
}

const tui = async (api: TuiPluginApi) => {
	api.command.register(() => {
		const sessionID = currentSessionID(api)

		return [
			{
				title: FORK_COMMAND_TITLE,
				value: "worktree.session.fork_from_message",
				category: SESSION_COMMAND_CATEGORY,
				enabled: Boolean(sessionID),
				onSelect: () => {
					if (!sessionID) {
						api.ui.toast({ message: "当前不在 session 页面", variant: "warning" })
						return
					}
					showForkDialog(api, sessionID)
				},
			},
			{
				title: NEW_COMMAND_TITLE,
				value: "worktree.session.new_window",
				category: SESSION_COMMAND_CATEGORY,
				onSelect: async () => {
					const cwd = getLaunchDirectory(api)
					if (!cwd) return
					const result = await api.client.session.create({})
					await openSpawnedSession(
						api,
						cwd,
						result,
						result.data?.id ?? "new-session",
						"已在新 tmux 窗口打开新 session",
					)
				},
			},
		]
	})
}

const plugin: TuiPluginModule = {
	id,
	tui,
}

export default plugin
