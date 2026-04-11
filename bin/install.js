#!/usr/bin/env node

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = "opencode-worktree"
const COMMAND_FILES = ["btw.md", "worktree-create.md", "worktree-delete.md"]

const cwd = process.cwd()

function configPaths(name) {
  return [
    join(cwd, `${name}.json`),
    join(cwd, `${name}.jsonc`),
    join(cwd, ".opencode", `${name}.json`),
    join(cwd, ".opencode", `${name}.jsonc`),
  ]
}

function findConfig(name) {
  for (const filePath of configPaths(name)) {
    if (existsSync(filePath)) return filePath
  }
  return null
}

function parseJsonc(content) {
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  return JSON.parse(stripped)
}

function ensurePluginInstalled(configPath, config, label) {
  const nextConfig = config && typeof config === "object" ? config : {}
  const plugins = Array.isArray(nextConfig.plugin) ? nextConfig.plugin : []

  if (!plugins.includes(PLUGIN_NAME)) {
    plugins.push(PLUGIN_NAME)
    nextConfig.plugin = plugins
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`)
    console.log(`  Added ${PLUGIN_NAME} to ${label} plugins`)
    return
  }

  console.log(`  ${label} plugin already installed`)
}

function installConfig(name, defaultFile) {
  let configPath = findConfig(name)
  let config = { plugin: [] }

  if (configPath) {
    console.log(`  Found ${name} config: ${configPath}`)
    try {
      config = parseJsonc(readFileSync(configPath, "utf-8"))
    } catch (error) {
      console.error(`  Error parsing ${name} config. Please add plugin manually:\n`)
      console.error(`    \"plugin\": [\"${PLUGIN_NAME}\"]`)
      console.error(`\n  ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
  } else {
    configPath = join(cwd, defaultFile)
    console.log(`  Creating ${name} config: ${configPath}`)
  }

  ensurePluginInstalled(configPath, config, name)
}

function copyCommands() {
  const commandDir = join(homedir(), ".config", "opencode", "commands")
  mkdirSync(commandDir, { recursive: true })

  for (const file of COMMAND_FILES) {
    const source = join(__dirname, "..", ".opencode", "command", file)
    if (!existsSync(source)) continue

    const target = join(commandDir, file)
    copyFileSync(source, target)
    console.log(`  Copied /${file.replace(/\.md$/, "")} command to ${target}`)
  }
}

function main() {
  console.log(`\n  Installing ${PLUGIN_NAME}...\n`)

  installConfig("opencode", "opencode.json")
  installConfig("tui", "tui.json")
  copyCommands()

  console.log("\n  Done! Run 'opencode' to start.\n")
  console.log("  Usage:")
  console.log("    /btw [prompt...]                  - Fork current session into a new terminal")
  console.log("    /worktree-create <branch> [base]  - Create a worktree directly")
  console.log("    /worktree-delete <reason...>      - Delete current worktree directly\n")
}

main()
