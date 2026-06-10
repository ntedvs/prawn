# prawn

A small TypeScript agent playground built with Bun and Effect. It includes a CLI, an OpenTUI interface, provider adapters, MCP tool loading, session persistence, and a built-in bash tool.

## Requirements

- [Bun](https://bun.sh/)

## Install

```sh
bun install
```

## Usage

Run the CLI with a prompt:

```sh
bun run dev "run echo hello and tell me what happened"
```

Launch the TUI:

```sh
bun run tui
```

Authenticate with OpenAI/Codex support:

```sh
bun run dev login
```

If no login is found, prawn falls back to the mock provider.

## Sessions

Sessions are saved under `~/.prawn/sessions`.

```sh
bun run dev --continue          # continue the latest session in this directory
bun run dev --resume <id>       # resume a specific session
bun run tui --resume            # open the session picker
```

## MCP tools

prawn loads MCP servers from:

- `~/.prawn/mcp.json`
- `.prawn/mcp.json`

Local project config is merged with the user config.

## Development

This is a Bun workspace with packages in `packages/*`:

- `@prawn/core` — agent loop, events, tools, persistence
- `@prawn/cli` — command-line entry point
- `@prawn/tui` — terminal UI
- `@prawn/providers` — model/provider adapters
- `@prawn/mcp` — MCP tool integration
- `@prawn/tools` — built-in tools
