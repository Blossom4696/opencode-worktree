import type {
	TuiCommand,
	TuiDialogSelectOption,
	TuiPlugin,
	TuiPluginApi,
	TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { forkSessionIntoNewWindow } from "./plugin/worktree/fork-session.ts"
import { openTerminal } from "./plugin/worktree/terminal"


const id = "opencode-worktree"
const SESSION_COMMAND_CATEGORY = "Session"
const FORK_COMMAND_TITLE = "Fork from message in new tmux window"
const NEW_COMMAND_TITLE = "New session in new tmux window"

function currentSessionID(api: TuiPluginApi): string | undefined {
	if (api.route.current.name !== "session") return undefined
	const sessionID = api.route.current.params?.sessionID
	return typeof sessionID === "string" ? sessionID : undefined
}

function getForkableMessageOptions(api: TuiPluginApi, sessionID: string): TuiDialogSelectOption<string>[] {
	const options: TuiDialogSelectOption<string>[] = []
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
				onSelect: () => {
					void (async () => {
						const cwd = getLaunchDirectory(api)
						if (!cwd) return
						const result = await forkSessionIntoNewWindow({
							client: api.client,
							directory: cwd,
							sessionId: sessionID,
							messageId: option.value,
							log: {
								debug: () => {},
								warn: () => {},
							},
							openInDetachedTmux: true,
						})
						if (!result.ok) {
							api.ui.toast({ message: result.error, variant: "error" })
							return
						}

						api.ui.toast({ message: "已在新 tmux 窗口打开 fork session", variant: "success" })
						api.ui.dialog.clear()
					})()
				},
			})),
		})
	})
}


const tui: TuiPlugin = async (api) => {
	api.command.register(() => {
		const sessionID = currentSessionID(api)

		const commands: TuiCommand[] = [
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
				onSelect: () => {
					void (async () => {
						const cwd = getLaunchDirectory(api)
						if (!cwd) return
						const openResult = await openTerminal(cwd, "opencode", "new-session", {
							detachedInTmux: true,
						})
						if (!openResult.success) {
							api.ui.toast({
								message: `打开新 session 失败：${openResult.error ?? "未知错误"}`,
								variant: "error",
							})
							return
						}

						api.ui.toast({ message: "已在新 tmux 窗口打开新 session", variant: "success" })
					})()
				},
			},
		]

		return commands
	})
}

const plugin: TuiPluginModule = {
	id,
	tui,
}

export default plugin
