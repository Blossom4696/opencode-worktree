import type {
	TuiCommand,
	TuiDialogSelectOption,
	TuiPlugin,
	TuiPluginApi,
	TuiPluginModule,
} from "@opencode-ai/plugin/tui"
import type { TextPart } from "@opencode-ai/sdk/v2"
import { forkSessionIntoNewWindow } from "./plugin/worktree/fork-session.ts"
import {
	formatLaunchSessionMessage,
	launchWorktreeSession,
	type LaunchMode,
} from "./plugin/worktree/launch-session"
import { openTerminal } from "./plugin/worktree/terminal"

const id = "opencode-worktree"
const SESSION_COMMAND_CATEGORY = "Session"
const FORK_COMMAND_TITLE = "Fork from message in new tmux window"
const NEW_COMMAND_TITLE = "New session in new tmux window"
const WORKTREE_SESSION_COMMAND_TITLE = "Worktree session (ctrl+p)"

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
	api.ui.toast({ message: "当前目录不可用，无法创建 worktree session", variant: "error" })
	return undefined
}

function selectDialog<Value>(
	api: TuiPluginApi,
	props: {
		title: string
		options: TuiDialogSelectOption<Value>[]
		size?: "medium" | "large" | "xlarge"
	},
): Promise<TuiDialogSelectOption<Value> | undefined> {
	return new Promise((resolve) => {
		let settled = false
		const finish = (value: TuiDialogSelectOption<Value> | undefined) => {
			if (settled) return
			settled = true
			resolve(value)
		}

		api.ui.dialog.replace(
			() => {
				api.ui.dialog.setSize(props.size ?? "large")
				return api.ui.DialogSelect({
					title: props.title,
					options: props.options,
					onSelect: (option) => {
						finish(option)
						api.ui.dialog.clear()
					},
				})
			},
			() => finish(undefined),
		)
	})
}

function promptDialog(
	api: TuiPluginApi,
	props: {
		title: string
		placeholder?: string
		value?: string
	},
): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false
		const finish = (value: string | undefined) => {
			if (settled) return
			settled = true
			resolve(value)
		}

		api.ui.dialog.replace(
			() => {
				api.ui.dialog.setSize("medium")
				return api.ui.DialogPrompt({
					title: props.title,
					placeholder: props.placeholder,
					value: props.value,
					onConfirm: (value) => {
						finish(value)
						api.ui.dialog.clear()
					},
					onCancel: () => {
						finish(undefined)
						api.ui.dialog.clear()
					},
				})
			},
			() => finish(undefined),
		)
	})
}

async function runWorktreeSessionFlow(api: TuiPluginApi): Promise<void> {
	const cwd = getLaunchDirectory(api)
	if (!cwd) return

	const sessionID = currentSessionID(api)
	const forkableMessages = sessionID ? getForkableMessageOptions(api, sessionID) : []

	const modeOption = await selectDialog(api, {
		title: "选择模式",
		options: [
			{ title: "new-session", value: "new-session" as const },
			{
				title: "fork-from-message",
				value: "fork-from-message" as const,
				disabled: !sessionID || forkableMessages.length === 0,
				description: !sessionID
					? "仅在 session 页面可用"
					: forkableMessages.length === 0
						? "当前 session 没有可 fork 的用户文本消息"
						: undefined,
			},
		],
	})
	if (!modeOption) return

	const mode = modeOption.value as LaunchMode
	let messageId: string | undefined

	if (mode === "fork-from-message") {
		if (!sessionID) {
			api.ui.toast({ message: "当前不在 session 页面，无法 fork", variant: "error" })
			return
		}

		const messageOption = await selectDialog(api, {
			title: "选择 fork 起点消息",
			options: forkableMessages,
		})
		if (!messageOption) return
		messageId = messageOption.value
	}

	const worktreeName = (await promptDialog(api, {
		title: "输入 worktreeName",
		placeholder: "例如: feature-ctrl-p",
	}))?.trim()
	if (!worktreeName) {
		api.ui.toast({ message: "worktreeName 不能为空", variant: "warning" })
		return
	}

	const customDirectoryName = await promptDialog(api, {
		title: "输入 customDirectoryName（可选）",
		placeholder: "留空则使用默认目录名",
	})

	const result = await launchWorktreeSession({
		client: api.client,
		repoRoot: cwd,
		mode,
		worktreeName,
		customDirectoryName: customDirectoryName?.trim() || undefined,
		currentSessionId: sessionID,
		messageId,
		openInDetachedTmux: true,
	})

	api.ui.toast({
		message: formatLaunchSessionMessage(result),
		variant: result.ok ? "success" : "error",
		duration: result.ok ? 5000 : 8000,
	})
}

const tui: TuiPlugin = async (api) => {
	api.command.register(() => {
		const sessionID = currentSessionID(api)
		const forkableMessages = sessionID ? getForkableMessageOptions(api, sessionID) : []

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
					if (forkableMessages.length === 0) {
						api.ui.toast({ message: "当前 session 没有可 fork 的用户文本消息", variant: "warning" })
						return
					}

					void (async () => {
						const selected = await selectDialog(api, {
							title: FORK_COMMAND_TITLE,
							options: forkableMessages,
						})
						if (!selected) return

						const cwd = getLaunchDirectory(api)
						if (!cwd) return
						const result = await forkSessionIntoNewWindow({
							client: api.client,
							directory: cwd,
							sessionId: sessionID,
							messageId: selected.value,
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
					})()
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
			{
				title: WORKTREE_SESSION_COMMAND_TITLE,
				value: "worktree.session.launch",
				category: SESSION_COMMAND_CATEGORY,
				onSelect: () => {
					void runWorktreeSessionFlow(api)
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
