import { access, mkdir } from "node:fs/promises"
import * as path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { z } from "zod"
import { forkSessionWithContext } from "./fork-session"
import { buildDefaultDirectoryName, normalizeDirectoryName } from "./path-utils"
import { addSession, initStateDb } from "./state"
import { openSessionTerminal } from "./terminal"

export type LaunchMode = "new-session" | "fork-from-message"

const branchNameSchema = z
	.string()
	.min(1, "工作树名称不能为空")
	.refine((name) => !name.startsWith("-"), "分支名不能以 - 开头")
	.refine((name) => !name.startsWith("/") && !name.endsWith("/"), "分支名不能以 / 开头或结尾")
	.refine((name) => !name.includes("//"), "分支名不能包含 //")
	.refine((name) => !name.includes("@{"), "分支名不能包含 @{")
	.refine((name) => !name.includes(".."), "分支名不能包含 ..")
	// biome-ignore lint/suspicious/noControlCharactersInRegex: security validation
	.refine((name) => !/[\x00-\x1f\x7f ~^:?*[\]\\]/.test(name), "分支名包含非法字符")
	.refine((name) => !name.endsWith(".lock"), "分支名不能以 .lock 结尾")

function normalizeName(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^a-z0-9./-]+/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/-{2,}/g, "-")
		.replace(/^[-./]+|[-./]+$/g, "")
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch (e: unknown) {
		if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
			return false
		}
		throw e
	}
}

async function git(args: string[], cwd: string): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
	try {
		const bun = (globalThis as { Bun?: { spawn: (...args: any[]) => any } }).Bun
		if (!bun) {
			return { ok: false, error: "Bun runtime unavailable" }
		}

		const proc = bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		})
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		])
		if (exitCode !== 0) {
			return { ok: false, error: stderr.trim() || `git ${args[0]} failed` }
		}
		return { ok: true, value: stdout.trim() }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
	const result = await git(["rev-parse", "--verify", branch], cwd)
	return result.ok
}

export function resolveWorktreeTarget(input: {
	repoRoot: string
	worktreeName: string
	customDirectoryName?: string
}):
	| { ok: true; value: { branch: string; directoryName: string; worktreePath: string } }
	| { ok: false; error: string } {
	const branch = normalizeName(input.worktreeName)
	const parsedBranch = branchNameSchema.safeParse(branch)
	if (!parsedBranch.success) {
		return { ok: false, error: parsedBranch.error.issues[0]?.message ?? "非法工作树名称" }
	}

	const directoryName = input.customDirectoryName?.trim()
		? normalizeDirectoryName(input.customDirectoryName)
		: buildDefaultDirectoryName(input.repoRoot, input.worktreeName)

	if (!directoryName || directoryName === "." || directoryName === "..") {
		return { ok: false, error: "目录名非法，请重新输入" }
	}

	const repoParent = path.dirname(input.repoRoot)
	const worktreePath = path.join(repoParent, directoryName)

	return {
		ok: true,
		value: {
			branch,
			directoryName,
			worktreePath,
		},
	}
}

export type LaunchSessionResult = {
	ok: boolean
	failedAt?: "resolve" | "worktree" | "session" | "terminal"
	error?: string
	branch?: string
	directoryName?: string
	worktreePath?: string
	sessionId?: string
	resumeCommand?: string
}

export async function launchWorktreeSession(input: {
	client: OpencodeClient
	repoRoot: string
	mode: LaunchMode
	worktreeName: string
	customDirectoryName?: string
	currentSessionId?: string
	messageId?: string
	openInDetachedTmux?: boolean
}): Promise<LaunchSessionResult> {
	const target = resolveWorktreeTarget({
		repoRoot: input.repoRoot,
		worktreeName: input.worktreeName,
		customDirectoryName: input.customDirectoryName,
	})
	if (!target.ok) {
		return { ok: false, failedAt: "resolve", error: target.error }
	}

	const { branch, directoryName, worktreePath } = target.value

	if (await pathExists(worktreePath)) {
		return {
			ok: false,
			failedAt: "worktree",
			error: `目录已存在：${worktreePath}`,
			branch,
			directoryName,
			worktreePath,
		}
	}

	await mkdir(path.dirname(worktreePath), { recursive: true })

	const exists = await branchExists(input.repoRoot, branch)
	const addResult = exists
		? await git(["worktree", "add", worktreePath, branch], input.repoRoot)
		: await git(["worktree", "add", "-b", branch, worktreePath, "HEAD"], input.repoRoot)

	if (!addResult.ok) {
		return {
			ok: false,
			failedAt: "worktree",
			error: addResult.error,
			branch,
			directoryName,
			worktreePath,
		}
	}

	let sessionId: string | undefined
	try {
		if (input.mode === "fork-from-message") {
			if (!input.currentSessionId) {
				return {
					ok: false,
					failedAt: "session",
					error: "当前不在 session 页面，无法 fork",
					branch,
					directoryName,
					worktreePath,
				}
			}
			const forked = await forkSessionWithContext({
				client: input.client,
				directory: worktreePath,
				sessionId: input.currentSessionId,
				messageId: input.messageId,
			})
			sessionId = forked.sessionId
		} else {
			const created = await input.client.session.create({ directory: worktreePath })
			sessionId = created.data?.id
		}
	} catch (error) {
		return {
			ok: false,
			failedAt: "session",
			error: error instanceof Error ? error.message : String(error),
			branch,
			directoryName,
			worktreePath,
		}
	}

	if (!sessionId) {
		return {
			ok: false,
			failedAt: "session",
			error: "创建/获取 session 失败",
			branch,
			directoryName,
			worktreePath,
		}
	}

	const resumeCommand = `opencode --session ${sessionId}`
	try {
		const db = await initStateDb(input.repoRoot)
		addSession(db, {
			id: sessionId,
			branch,
			path: worktreePath,
			createdAt: new Date().toISOString(),
		})
		db.close()
	} catch {
		// ignore state persistence error, do not block launch flow
	}

	const terminalResult = await openSessionTerminal(worktreePath, sessionId, branch, {
		detachedInTmux: input.openInDetachedTmux ?? true,
	})

	if (!terminalResult.success) {
		return {
			ok: false,
			failedAt: "terminal",
			error: terminalResult.error ?? "打开终端失败",
			branch,
			directoryName,
			worktreePath,
			sessionId,
			resumeCommand,
		}
	}

	return {
		ok: true,
		branch,
		directoryName,
		worktreePath,
		sessionId,
		resumeCommand,
	}
}

export function formatLaunchSessionMessage(result: LaunchSessionResult): string {
	if (result.ok) {
		return `已创建 worktree session：${result.branch}\n目录：${result.worktreePath}`
	}

	const stepLabel = {
		resolve: "名称解析",
		worktree: "创建 worktree",
		session: "创建/获取 session",
		terminal: "打开终端",
	}[result.failedAt ?? "resolve"]

	const recovery = result.resumeCommand ? `\n手动恢复：${result.resumeCommand}` : ""
	const location = result.worktreePath ? `\n目录：${result.worktreePath}` : ""
	return `worktree session 失败（${stepLabel}）：${result.error ?? "未知错误"}${location}${recovery}`
}
