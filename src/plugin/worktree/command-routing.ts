export class WorktreeCommandHandledError extends Error {
	constructor() {
		super("Worktree command handled locally")
		this.name = "WorktreeCommandHandledError"
	}
}

type ParsedTokens = {
	values: string[]
	error?: string
}

export type ParsedWorktreeCommand =
	| { command: "btw"; prompt?: string }
	| { command: "worktree-create"; branch: string; baseBranch?: string }
	| { command: "worktree-delete"; reason: string }

function tokenizeArguments(input: string): ParsedTokens {
	const values: string[] = []
	let current = ""
	let quote: '"' | "'" | null = null
	let escaping = false

	for (const char of input) {
		if (escaping) {
			current += char
			escaping = false
			continue
		}

		if (char === "\\") {
			escaping = true
			continue
		}

		if (quote) {
			if (char === quote) {
				quote = null
			} else {
				current += char
			}
			continue
		}

		if (char === '"' || char === "'") {
			quote = char
			continue
		}

		if (/\s/.test(char)) {
			if (current) {
				values.push(current)
				current = ""
			}
			continue
		}

		current += char
	}

	if (escaping) return { values, error: "命令参数不能以反斜杠结尾" }
	if (quote) return { values, error: "命令参数存在未闭合引号" }
	if (current) values.push(current)

	return { values }
}

export function parseWorktreeCommand(
	command: string,
	argumentsText: string,
): { ok: true; value: ParsedWorktreeCommand } | { ok: false; error: string } | null {
	if (command !== "btw" && command !== "worktree-create" && command !== "worktree-delete") {
		return null
	}

	const trimmed = argumentsText.trim()

	if (command === "btw") {
		return {
			ok: true,
			value: {
				command,
				prompt: trimmed || undefined,
			},
		}
	}

	const parsed = tokenizeArguments(trimmed)
	if (parsed.error) return { ok: false, error: parsed.error }

	if (command === "worktree-create") {
		const [branch, baseBranch, ...rest] = parsed.values
		if (!branch) {
			return { ok: false, error: "用法：/worktree-create <branch> [baseBranch]" }
		}
		if (rest.length > 0) {
			return { ok: false, error: "用法：/worktree-create <branch> [baseBranch]" }
		}
		return {
			ok: true,
			value: {
				command,
				branch,
				baseBranch,
			},
		}
	}

	if (parsed.values.length === 0) {
		return { ok: false, error: "用法：/worktree-delete <reason...>" }
	}

	return {
		ok: true,
		value: {
			command,
			reason: parsed.values.join(" "),
		},
	}
}
