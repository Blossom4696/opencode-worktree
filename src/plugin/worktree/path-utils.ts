import * as path from "node:path"

export function normalizeDirectoryName(input: string): string {
	return input
		.trim()
		.replace(/[\\/]/g, "-")
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
}

export function buildDefaultDirectoryName(repoRoot: string, worktreeName: string): string {
	const repoName = path.basename(repoRoot)
	const normalized = normalizeDirectoryName(worktreeName) || "worktree"
	return `${repoName}-${normalized}`
}
