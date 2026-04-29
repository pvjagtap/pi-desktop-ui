# Agents

## Overview

`pi-desktop-ui` is a pi extension that renders a native desktop webview window alongside the terminal, mirroring an active pi agent session in real time. It does not run its own LLM — it hooks into the pi coding agent via `ExtensionAPI` and forwards every agent event to the GUI.

---

## Extension Entry Point

`index.ts` exports a single default function:

```ts
export default function desktopTuiExtension(pi: ExtensionAPI): void
```

Pi discovers and loads this via the `"pi"` block in `package.json`:

```json
"pi": {
  "extensions": ["./index.ts"]
}
```

---

## Agent Event Hooks

All LLM and tool events are received through `pi.on(event, handler)`.

| Event | What it does |
|---|---|
| `session_start` | Resolves project name and git branch; activates footer widget; conditionally auto-opens the window |
| `session_shutdown` | Marks the window as session-inactive without closing it (window persists across reloads) |
| `before_provider_request` | Forwards current model ID, thinking level, and provider to the window header |
| `agent_start` | Sends a loading indicator to the window |
| `agent_end` | Clears loading state; sends updated token stats |
| `message_start` | Opens a new streaming message bubble in the window |
| `message_update` | Streams granular token deltas: `text_delta`, `text_start`, `text_end`, `thinking_delta`, `thinking_start`, `thinking_end`, `toolcall_start`, `toolcall_end` |
| `message_end` | Finalises the streaming bubble and sends updated token stats |
| `tool_execution_start` | Opens a tool-call card in the window with tool name and arguments |
| `tool_execution_end` | Populates the tool-call card with the result; for `edit` tool results, encodes diffs as base64 JSON to survive the Glimpse bridge |
| `input` | Intercepts terminal keystrokes to inject slash commands that originated from the GUI back into pi's normal input pipeline with `expandPromptTemplates: true` |

---

## Sending Input to the Agent

The window can send user messages into the active agent loop:

```ts
pi.sendUserMessage(text)
```

This bypasses the terminal — the text flows directly into pi's next inference turn, identical to a user typing in the TUI.

For slash commands, `injectIntoTerminal()` routes them through `sendUserMessage()` and then intercepts the resulting `input` event to redirect through pi's full command pipeline.

---

## Plan Mode

When plan mode is active, a system prompt is prepended to every outgoing user message:

```ts
// index.ts ~line 627
const PLAN_MODE_PROMPT = `You are in PLAN MODE. You may only use read-only and search tools...`
```

This constrains the LLM to read/search tools and prevents file writes. It is enforced purely at the prompt level — not through API restrictions.

---

## Token Stats

`getTokenStats(ctx: ExtensionContext)` walks the active session branch's `AssistantMessage` entries and accumulates:

- Input tokens
- Output tokens  
- Cache read tokens
- Estimated cost (USD)

Stats are sent to the window on every `agent_end` and `message_end` event.

---

## Window Communication Protocol

The extension and the webview communicate through the Glimpse bridge.

### Extension → Window

```ts
sendToWindow(message: object): void
```

Messages are double-JSON-stringified and delivered by evaluating `window.__desktopReceive(JSON.parse(...))` inside the webview. All non-ASCII characters are escaped to `\uXXXX` to prevent Windows CP1252 corruption on the bridge.

### Window → Extension

The webview calls `window.glimpse.send(payload)`. The extension receives this in `handleWindowMessage(msg)` and dispatches on `msg.type`.

**Inbound message types (window → extension):**

| Type | Description |
|---|---|
| `send_message` | Send user text to the agent via `pi.sendUserMessage()` |
| `interrupt` | Interrupt the current agent turn |
| `run_command` | Run a pi slash command |
| `open_file` | Open a file with the OS default application |
| `get_file_contents` | Read a file and return its contents to the window |
| `attach_file` | Copy a file to a temp path and attach it to the next message |
| `save_skill` | Write a skill file to disk |
| `delete_skill` | Delete a skill file from disk |
| `navigate_workspace` | Launch a new pi session in a different workspace directory |
| `open_session` | Resume a past session thread |
| `toggle_plan_mode` | Enable or disable plan mode |
| `set_hidden_workspaces` | Persist workspace visibility preferences |
| `refresh_file_tree` | Re-scan the workspace directory tree |
| `set_theme` | Update the window colour theme |
| `open_diff` | Open a file diff overlay in the window |

**Outbound message types (extension → window):**

| Type | Description |
|---|---|
| `session_update` | Full session state refresh (messages, threads, stats) |
| `message_start` | New streaming bubble opened |
| `message_update` | Token delta streamed into open bubble |
| `message_end` | Streaming bubble finalised |
| `tool_start` | Tool-call card opened |
| `tool_end` | Tool-call card populated with result |
| `agent_start` | Loading indicator shown |
| `agent_end` | Loading indicator cleared; stats updated |
| `token_stats` | Updated token/cost counters |
| `model_info` | Current model ID, thinking level, provider |
| `file_contents` | Response to `get_file_contents` |
| `file_tree` | Updated directory listing |
| `plan_mode` | Current plan mode state |

---

## Window Initialisation Data

When the window opens, `collectWindowData(ctx)` assembles a snapshot passed as base64-encoded JSON into the HTML template (`__INLINE_DATA__`):

- All current session messages
- Token stats
- Session threads for all workspaces
- Installed skills
- Loaded extensions
- Known workspaces
- File explorer listing
- All registered pi commands
- Hidden workspace preferences

This lets the frontend render the full session state immediately, before any live events arrive.

---

## Security Boundaries

- File reads are path-traversal-protected: resolved paths must stay within `~/.pi/agent/` or the active workspace root
- All HTML rendered in the window is sanitised with DOMPurify before insertion into the DOM
- The Glimpse bridge does not expose Node.js APIs to the webview — all privileged operations go through the explicit `handleWindowMessage` dispatch table
- Edit diffs are transported as base64 JSON (not raw HTML) to prevent injection via file content

---

## Activation

The window can be opened by any of:

| Method | Details |
|---|---|
| `PI_DESKTOP=1` env var | Auto-opens on `session_start` |
| `--desktop` CLI flag | Auto-opens on `session_start` |
| `/desktop` slash command | Opens or focuses the window |
| `/nav` slash command | Opens or focuses the window |
| `Ctrl+Alt+N` keyboard shortcut | Opens or focuses the window |
| `pi-desktop.sh` / `pi-desktop.cmd` | Launcher scripts that set `PI_DESKTOP=1` |
