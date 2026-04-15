import { access, copyFile, cp, mkdir, rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { getProjectId } from "../kdco-primitives/get-project-id"
import { openSessionTerminal } from "./terminal"

const MAX_SESSION_CHAIN_DEPTH = 10

export interface WorktreeForkLogger {
	debug: (msg: string) => void
	warn: (msg: string) => void
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath)
		return true
	} catch (e: unknown) {
		if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") return false
		throw e
	}
}

async function copyIfExists(src: string, dest: string): Promise<boolean> {
	if (!(await pathExists(src))) return false
	await copyFile(src, dest)
	return true
}

async function copyDirIfExists(src: string, dest: string): Promise<boolean> {
	if (!(await pathExists(src))) return false
	await cp(src, dest, { recursive: true })
	return true
}

async function getRootSessionId(client: OpencodeClient, sessionId: string): Promise<string> {
	let currentId = sessionId
	for (let depth = 0; depth < MAX_SESSION_CHAIN_DEPTH; depth++) {
		const session = await client.session.get({ sessionID: currentId })
		if (!session.data?.parentID) return currentId
		currentId = session.data.parentID
	}
	return currentId
}

async function forkWithContext(
	client: OpencodeClient,
	sessionId: string,
	directory: string,
	messageId?: string,
): Promise<{ id: string }> {
	const projectId = await getProjectId(directory)
	const rootSessionId = await getRootSessionId(client, sessionId)
	const forkedSessionResponse = await client.session.fork({
		sessionID: sessionId,
		messageID: messageId,
	})
	const forkedSession = forkedSessionResponse.data
	if (!forkedSession?.id) {
		throw new Error("Failed to fork session: no session data returned")
	}

	try {
		const workspaceBase = path.join(os.homedir(), ".local", "share", "opencode", "workspace")
		const delegationsBase = path.join(os.homedir(), ".local", "share", "opencode", "delegations")
		const destWorkspaceDir = path.join(workspaceBase, projectId, forkedSession.id)
		const destDelegationsDir = path.join(delegationsBase, projectId, forkedSession.id)

		await mkdir(destWorkspaceDir, { recursive: true })
		await mkdir(destDelegationsDir, { recursive: true })
		await copyIfExists(path.join(workspaceBase, projectId, rootSessionId, "plan.md"), path.join(destWorkspaceDir, "plan.md"))
		await copyDirIfExists(path.join(delegationsBase, projectId, rootSessionId), destDelegationsDir)
	} catch (error) {
		const workspaceBase = path.join(os.homedir(), ".local", "share", "opencode", "workspace")
		const delegationsBase = path.join(os.homedir(), ".local", "share", "opencode", "delegations")
		await rm(path.join(workspaceBase, projectId, forkedSession.id), { recursive: true, force: true }).catch(() => {})
		await rm(path.join(delegationsBase, projectId, forkedSession.id), { recursive: true, force: true }).catch(() => {})
		await client.session.delete({ sessionID: forkedSession.id }).catch(() => {})
		throw error
	}

	return { id: forkedSession.id }
}

export async function forkSessionWithContext(input: {
	client: OpencodeClient
	directory: string
	sessionId: string
	messageId?: string
}): Promise<{ sessionId: string }> {
	const forked = await forkWithContext(input.client, input.sessionId, input.directory, input.messageId)
	return { sessionId: forked.id }
}

export async function forkSessionIntoNewWindow(input: {
	client: OpencodeClient
	directory: string
	sessionId: string
	messageId?: string
	windowName?: string
	log: WorktreeForkLogger
	openInDetachedTmux?: boolean
}): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
	const { client, directory, sessionId, messageId, windowName, log, openInDetachedTmux = true } = input

	try {
		const forkedSession = await forkSessionWithContext({
			client,
			directory,
			sessionId,
			messageId,
		})
		log.debug(`Forked session ${forkedSession.sessionId}, launched via shared helper`)

		const terminalResult = await openSessionTerminal(directory, forkedSession.sessionId, windowName, {
			detachedInTmux: openInDetachedTmux,
		})
		if (!terminalResult.success) {
			return {
				ok: false,
				error: `已创建 session ${forkedSession.sessionId}，但打开终端失败：${terminalResult.error ?? "未知错误"}`,
			}
		}

		return { ok: true, sessionId: forkedSession.sessionId }
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) }
	}
}
