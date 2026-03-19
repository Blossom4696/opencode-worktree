#!/usr/bin/env bun

import { execFileSync } from "node:child_process"
import { lstat, mkdir, readdir, readlink, realpath, rm, stat, symlink } from "node:fs/promises"
import path from "node:path"

type Options = {
	dryRun: boolean
	source?: string
	target?: string
}

function parseArgs(argv: string[]): Options {
	const options: Options = { dryRun: false }

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]
		if (arg === "--dry-run") {
			options.dryRun = true
			continue
		}
		if (arg === "--source") {
			options.source = argv[i + 1]
			i += 1
			continue
		}
		if (arg === "--target") {
			options.target = argv[i + 1]
			i += 1
			continue
		}
		throw new Error(`Unknown argument: ${arg}`)
	}

	return options
}

function getGitTopLevel(cwd: string): string {
	return execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd,
		encoding: "utf8",
	}).trim()
}

function listWorktrees(cwd: string): Array<{ path: string }> {
	const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
		cwd,
		encoding: "utf8",
	})

	const worktrees: Array<{ path: string }> = []
	let current: { path: string } | null = null

	for (const line of output.split("\n")) {
		if (!line.trim()) {
			if (current?.path) worktrees.push(current)
			current = null
			continue
		}

		if (line.startsWith("worktree ")) {
			if (current?.path) worktrees.push(current)
			current = { path: line.slice("worktree ".length) }
		}
	}

	if (current?.path) worktrees.push(current)
	return worktrees
}

async function pathExists(filePath: string): Promise<boolean> {
	try {
		await lstat(filePath)
		return true
	} catch {
		return false
	}
}

async function findMainCheckout(currentRoot: string): Promise<string> {
	const worktrees = listWorktrees(currentRoot)

	for (const worktree of worktrees) {
		const gitPath = path.join(worktree.path, ".git")
		try {
			const info = await stat(gitPath)
			if (info.isDirectory()) return worktree.path
		} catch {}
	}

	throw new Error("Unable to locate the main checkout from git worktree list")
}

async function collectNodeModules(root: string): Promise<string[]> {
	const results: string[] = []
	const stack: string[] = [root]

	while (stack.length > 0) {
		const currentDir = stack.pop()
		if (!currentDir) continue

		const entries = await readdir(currentDir, { withFileTypes: true })

		for (const entry of entries) {
			if (!entry.isDirectory()) continue
			if (entry.name === ".git" || entry.name === "node_modules") continue
			stack.push(path.join(currentDir, entry.name))
		}

		const nodeModulesPath = path.join(currentDir, "node_modules")
		if (await pathExists(nodeModulesPath)) {
			results.push(nodeModulesPath)
		}
	}

	results.sort((left, right) => left.localeCompare(right))
	return results
}

async function isCorrectSymlink(targetPath: string, sourcePath: string): Promise<boolean> {
	try {
		const info = await lstat(targetPath)
		if (!info.isSymbolicLink()) return false

		const linkedPath = await readlink(targetPath)
		const resolvedTarget = path.resolve(path.dirname(targetPath), linkedPath)
		const [actualSource, actualTarget] = await Promise.all([
			realpath(sourcePath),
			realpath(resolvedTarget),
		])

		return actualSource === actualTarget
	} catch {
		return false
	}
}

async function syncOne(
	sourceRoot: string,
	targetRoot: string,
	sourceNodeModulesPath: string,
	dryRun: boolean,
): Promise<void> {
	const relativePath = path.relative(sourceRoot, sourceNodeModulesPath)
	const targetNodeModulesPath = path.join(targetRoot, relativePath)

	if (await isCorrectSymlink(targetNodeModulesPath, sourceNodeModulesPath)) {
		console.log(`[skip] ${relativePath} already linked`)
		return
	}

	console.log(`[link] ${relativePath}`)
	console.log(`       source: ${sourceNodeModulesPath}`)
	console.log(`       target: ${targetNodeModulesPath}`)

	if (dryRun) return

	await mkdir(path.dirname(targetNodeModulesPath), { recursive: true })
	await rm(targetNodeModulesPath, { recursive: true, force: true })
	await symlink(sourceNodeModulesPath, targetNodeModulesPath, "dir")
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2))
	const targetRoot = path.resolve(options.target ?? getGitTopLevel(process.cwd()))
	const sourceRoot = path.resolve(options.source ?? (await findMainCheckout(targetRoot)))

	console.log(`[sync-node-modules] source=${sourceRoot}`)
	console.log(`[sync-node-modules] target=${targetRoot}`)
	if (options.dryRun) console.log("[sync-node-modules] dry-run enabled")

	if (sourceRoot === targetRoot) {
		console.log("[sync-node-modules] source and target are identical; nothing to sync")
		return
	}

	const sourceNodeModulesPaths = await collectNodeModules(sourceRoot)
	if (sourceNodeModulesPaths.length === 0) {
		console.log("[sync-node-modules] no node_modules directories found in source checkout")
		return
	}

	for (const sourceNodeModulesPath of sourceNodeModulesPaths) {
		await syncOne(sourceRoot, targetRoot, sourceNodeModulesPath, options.dryRun)
	}

	console.log(`[sync-node-modules] synced ${sourceNodeModulesPaths.length} node_modules path(s)`)
}

void main().catch((error: unknown) => {
	console.error(`[sync-node-modules] ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
})
