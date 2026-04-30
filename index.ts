/**
 * Desktop TUI Extension — Fully Functional Native Chat Window
 *
 * Opens a Glimpse native webview window that mirrors the pi terminal session:
 * - Full bidirectional chat: send messages, stream responses in real-time
 * - Markdown-rendered assistant messages with syntax highlighting
 * - Tool execution indicators (tool calls, results)
 * - Sidebar: threads, skills, settings, explorer, workspace
 * - Ctrl+Alt+N or /nav or /desktop to open
 * - Custom footer + context widget in the terminal
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, basename, dirname, extname, resolve, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { exec, spawn } from "node:child_process";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { open } from "glimpseui";

type GlimpseWindow = ReturnType<typeof open>;

// Persist the Glimpse window reference across extension reloads (e.g. /new, /reload).
// When pi starts a new session, extensions are re-instantiated — local variables die.
// Storing on globalThis lets the new instance "adopt" the surviving window.
const __piDesktop = (globalThis as any).__piDesktop ??= { window: null as GlimpseWindow | null };

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = join(__dirname, "web");

// ─── Security Helpers ────────────────────────────────────────

const MAX_ATTACH_SIZE = 25 * 1024 * 1024; // 25 MB max attachment

/** Validate that a path is within allowed directories (sessions, cwd, or home). */
function isPathAllowed(filePath: string, ctx: { cwd: string } | null): boolean {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const resolved = resolve(normalize(filePath));
	const sessionsDir = resolve(join(home, ".pi", "agent", "sessions"));

	// Allow paths under the sessions directory
	if (resolved.startsWith(sessionsDir + "/") || resolved.startsWith(sessionsDir + "\\")) return true;

	// Allow paths under the current working directory
	if (ctx) {
		const cwdResolved = resolve(ctx.cwd);
		if (resolved.startsWith(cwdResolved + "/") || resolved.startsWith(cwdResolved + "\\") || resolved === cwdResolved) return true;
	}

	return false;
}

/** Validate that a session file path is a .jsonl file inside the sessions directory. */
function isValidSessionFile(filePath: string): boolean {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const resolved = resolve(normalize(filePath));
	const sessionsDir = resolve(join(home, ".pi", "agent", "sessions"));

	if (!resolved.endsWith(".jsonl")) return false;
	if (!resolved.startsWith(sessionsDir + "/") && !resolved.startsWith(sessionsDir + "\\")) return false;

	// Reject path traversal attempts
	if (filePath.includes("..")) return false;

	return true;
}

// ─── Hidden Workspaces Persistence ───────────────────────────

function getHiddenWorkspacesPath(): string {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	return join(home, ".pi", "agent", "hidden-workspaces.json");
}

function loadHiddenWorkspaces(): Record<string, boolean> {
	try {
		const fp = getHiddenWorkspacesPath();
		if (existsSync(fp)) return JSON.parse(readFileSync(fp, "utf-8"));
	} catch {}
	return {};
}

function saveHiddenWorkspaces(hidden: Record<string, boolean>): void {
	try {
		writeFileSync(getHiddenWorkspacesPath(), JSON.stringify(hidden, null, 2));
	} catch {}
}

const BUILTIN_COMMANDS = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{ name: "scoped-models", description: "Enable/disable models for Ctrl+P cycling" },
	{ name: "export", description: "Export session (HTML default, or specify path)" },
	{ name: "import", description: "Import and resume a session from a JSONL file" },
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "fork", description: "Create a new fork from a previous message" },
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{ name: "login", description: "Login with OAuth provider" },
	{ name: "logout", description: "Logout from OAuth provider" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
	{ name: "quit", description: "Quit pi" },
];

function getAllCommands(pi: ExtensionAPI) {
	const extCommands = pi.getCommands().map(c => ({
		name: c.name,
		description: c.description || "",
		source: (c as any).sourceInfo?.source || "extension",
		scope: (c as any).sourceInfo?.scope || "",
		path: (c as any).sourceInfo?.path || "",
	}));
	const extNames = new Set(extCommands.map(c => c.name));
	return [
		...BUILTIN_COMMANDS.filter(c => !extNames.has(c.name)).map(c => ({ ...c, source: "built-in", scope: "app", path: "" })),
		...extCommands,
	].sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Helpers ─────────────────────────────────────────────────

function getProjectName(cwd: string): string { return basename(cwd); }

function fmt(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function getTokenStats(ctx: ExtensionContext) {
	let input = 0, output = 0, cost = 0, cache = 0;
	try {
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const m = e.message as AssistantMessage;
			input += m.usage.input;
			output += m.usage.output;
			cost += m.usage.cost.total;
			cache += (m.usage as any).cacheRead ?? 0;
		}
	}
	} catch { return { input, output, cost, cache }; }
	return { input, output, cost, cache };
}

function getSessionThreads(sessionDir: string | null) {
	if (!sessionDir || !existsSync(sessionDir)) return [];
	try {
		return readdirSync(sessionDir)
			.filter(f => f.endsWith(".jsonl"))
			.map(f => {
				const fp = join(sessionDir, f);
				const stat = statSync(fp);
				let name = f.replace(".jsonl", "");
				try {
					const content = readFileSync(fp, "utf-8");
					const line = content.split("\n").find(l => l.includes('"role":"user"') || l.includes('"role": "user"'));
					if (line) {
						const parsed = JSON.parse(line);
						const msgContent = parsed?.message?.content;
						let text = "";
						if (Array.isArray(msgContent)) {
							const textBlock = msgContent.find((b: any) => b.type === "text");
							if (textBlock?.text) text = textBlock.text;
						} else if (typeof msgContent === "string") {
							text = msgContent;
						}
						if (text.length > 0) name = text.slice(0, 70).replace(/\n/g, " ");
					}
				} catch {}
				return { name, file: fp, date: stat.mtime };
			})
			.sort((a, b) => b.date.getTime() - a.date.getTime());
	} catch { return []; }
}

function getSkills() {
	const skills: { name: string; desc: string }[] = [];
	const home = process.env.HOME || process.env.USERPROFILE || "";
	for (const dir of [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")]) {
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir)) {
				const sp = join(dir, entry, "SKILL.md");
				if (!existsSync(sp)) continue;
				let desc = "";
				try {
					const c = readFileSync(sp, "utf-8");
					const m = c.match(/description[:\s]*['"]*(.+?)['"]?\s*$/im);
					if (m) desc = m[1]!.trim().slice(0, 80);
				} catch {}
				if (!skills.find(s => s.name === entry)) skills.push({ name: entry, desc });
			}
		} catch {}
	}
	return skills;
}

function getExtensions() {
	const extensions: { name: string; source: string; type: string }[] = [];
	const home = process.env.HOME || process.env.USERPROFILE || "";

	// Built-in extensions from ~/.pi/agent/extensions/
	const builtinDir = join(home, ".pi", "agent", "extensions");
	if (existsSync(builtinDir)) {
		try {
			for (const entry of readdirSync(builtinDir)) {
				const entryPath = join(builtinDir, entry);
				try {
					if (statSync(entryPath).isDirectory() && (existsSync(join(entryPath, "index.ts")) || existsSync(join(entryPath, "index.js")))) {
						extensions.push({ name: entry, source: "built-in", type: "builtin" });
					}
				} catch {}
			}
		} catch {}
	}

	// Extensions from settings.json
	const settingsPath = join(home, ".pi", "agent", "settings.json");
	if (existsSync(settingsPath)) {
		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));

			// Direct extensions array (e.g. "+extensions/cmux/index.ts")
			if (Array.isArray(settings.extensions)) {
				for (const ext of settings.extensions) {
					if (typeof ext === "string") {
						const name = ext.replace(/^\+/, "").replace(/\/index\.(ts|js)$/, "").replace(/^extensions\//, "");
						if (!extensions.find(e => e.name === name)) {
							extensions.push({ name, source: "local", type: "local" });
						}
					}
				}
			}

			// Package extensions from "packages" array
			if (Array.isArray(settings.packages)) {
				for (const pkg of settings.packages) {
					let source = "";
					let pkgExtensions: string[] = [];

					if (typeof pkg === "string") {
						source = pkg;
					} else if (typeof pkg === "object" && pkg.source) {
						source = pkg.source;
						if (Array.isArray(pkg.extensions)) pkgExtensions = pkg.extensions;
					}

					if (pkgExtensions.length > 0) {
						const pkgName = source.replace(/^(git:|npm:)/, "").replace(/^github\.com\//, "").replace(/^https:\/\/github\.com\//, "");
						for (const ext of pkgExtensions) {
							const extName = ext.replace(/^\+/, "").replace(/\/index\.(ts|js)$/, "").replace(/^extensions?\//, "");
							extensions.push({ name: extName, source: pkgName, type: "package" });
						}
					} else if (source) {
						const pkgName = source.replace(/^(git:|npm:)/, "").replace(/^github\.com\//, "").replace(/^https:\/\/github\.com\//, "");
						const gitDir = join(home, ".pi", "agent", "git", "github.com", ...pkgName.split("/"));
						const hasExtension = existsSync(join(gitDir, "extension.ts")) || existsSync(join(gitDir, "extension.js"))
							|| existsSync(join(gitDir, "extension", "index.ts")) || existsSync(join(gitDir, "extension", "index.js"));
						if (hasExtension) {
							extensions.push({ name: pkgName.split("/").pop() || pkgName, source: pkgName, type: "package" });
						}
					}
				}
			}
		} catch {}
	}

	return extensions;
}

function decodeSessionDirName(dirName: string): string {
	// Reverse of: `--${cwd.replace(/^[\/\\]/, "").replace(/[\/\\:]/g, "-")}--`
	// The encoding is lossy: both path separators and literal hyphens become "-".
	// We use filesystem probing to resolve ambiguity.
	let decoded = dirName.replace(/^--/, "").replace(/--$/, "");

	const winMatch = decoded.match(/^([A-Za-z])--(.*)$/);
	if (winMatch) {
		// Windows path: drive letter + rest
		const drive = winMatch[1] + ":\\";
		const rest = winMatch[2];
		if (!rest) return drive;

		// Split on "-" and greedily resolve by checking which segments exist on disk
		const parts = rest.split("-");
		return drive + resolvePathSegments(drive, parts);
	} else {
		// Unix path
		const parts = decoded.split("-");
		return "/" + resolvePathSegments("/", parts);
	}
}

/** Greedily resolve ambiguous hyphen-separated segments by probing the filesystem. */
function resolvePathSegments(base: string, parts: string[]): string {
	if (parts.length === 0) return "";

	// Try joining progressively more parts with hyphens (greedy longest match)
	// At each position, find the longest segment that exists as a child of the current base
	let result: string[] = [];
	let i = 0;
	while (i < parts.length) {
		let bestLen = 0;
		// Try joining parts[i..j] with "-" to form a single path segment
		// Check longest first for greedy match
		for (let j = parts.length; j > i; j--) {
			const candidate = parts.slice(i, j).join("-");
			const testPath = join(base, ...result, candidate);
			try {
				if (existsSync(testPath)) {
					bestLen = j - i;
					break;
				}
			} catch {}
		}
		if (bestLen > 0) {
			result.push(parts.slice(i, i + bestLen).join("-"));
			i += bestLen;
		} else {
			// No match found on disk — fall back to single segment
			result.push(parts[i]);
			i++;
		}
	}
	return result.join("\\");
}

function getWorkspaces() {
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const sessionsRoot = join(home, ".pi", "agent", "sessions");
	if (!existsSync(sessionsRoot)) return [];

	const workspaces: { name: string; path: string; dirName: string; sessionCount: number; lastActive: Date }[] = [];

	try {
		for (const dirName of readdirSync(sessionsRoot)) {
			const dirPath = join(sessionsRoot, dirName);
			try {
				if (!statSync(dirPath).isDirectory()) continue;
			} catch { continue; }

			// Skip temp/worktree dirs to reduce noise
			if (dirName.includes("pi-gui-workspace") || dirName.includes("pi-gui-git-workspace") || dirName.includes("worktrees")) continue;

			const decodedPath = decodeSessionDirName(dirName);
			const name = basename(decodedPath) || decodedPath;

			// Count sessions and find most recent
			let sessionCount = 0;
			let lastActive = new Date(0);
			try {
				for (const f of readdirSync(dirPath)) {
					if (!f.endsWith(".jsonl")) continue;
					sessionCount++;
					try {
						const mtime = statSync(join(dirPath, f)).mtime;
						if (mtime > lastActive) lastActive = mtime;
					} catch {}
				}
			} catch {}

			if (sessionCount === 0) continue;

			workspaces.push({ name, path: decodedPath, dirName, sessionCount, lastActive });
		}
	} catch {}

	// Sort by most recently active
	workspaces.sort((a, b) => b.lastActive.getTime() - a.lastActive.getTime());
	return workspaces;
}

function getWorkspaceSessions(dirName: string) {
	// Reject traversal attempts
	if (dirName.includes("..") || dirName.includes("/") || dirName.includes("\\")) return [];
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const dirPath = join(home, ".pi", "agent", "sessions", dirName);
	return getSessionThreads(dirPath);
}

function searchSessionThreads(sessionDir: string | null, query: string): Array<{ name: string; file: string; date: Date; matchSnippet: string }> {
	if (!sessionDir || !existsSync(sessionDir) || !query) return [];
	const lowerQuery = query.toLowerCase();
	const results: Array<{ name: string; file: string; date: Date; matchSnippet: string }> = [];
	try {
		const files = readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"));
		for (const f of files) {
			const fp = join(sessionDir, f);
			const stat = statSync(fp);
			let threadName = f.replace(".jsonl", "");
			let matchSnippet = "";
			try {
				const content = readFileSync(fp, "utf-8");
				const lines = content.split("\n");
				let firstUserText = "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const entry = JSON.parse(line);
						if (entry.type !== "message") continue;
						const msg = entry.message;
						if (!msg) continue;
						let text = "";
						if (Array.isArray(msg.content)) {
							for (const b of msg.content) {
								if (b.type === "text" && b.text) text += b.text + " ";
							}
						} else if (typeof msg.content === "string") {
							text = msg.content;
						}
						text = text.trim();
						if (!text) continue;
						if (msg.role === "user" && !firstUserText) firstUserText = text;
						if (text.toLowerCase().includes(lowerQuery)) {
							// Extract snippet around the match
							const idx = text.toLowerCase().indexOf(lowerQuery);
							const start = Math.max(0, idx - 30);
							const end = Math.min(text.length, idx + query.length + 50);
							matchSnippet = (start > 0 ? "..." : "") + text.slice(start, end).replace(/\n/g, " ") + (end < text.length ? "..." : "");
							break;
						}
					} catch {}
				}
				if (firstUserText) threadName = firstUserText.slice(0, 70).replace(/\n/g, " ");
				if (matchSnippet) {
					results.push({ name: threadName, file: fp, date: stat.mtime, matchSnippet });
				}
			} catch {}
		}
	} catch {}
	results.sort((a, b) => b.date.getTime() - a.date.getTime());
	return results;
}

function extractSessionMessages(ctx: ExtensionContext) {
	const messages: Array<{ role: string; content: string; toolName?: string; images?: Array<{ data: string; mimeType: string }> }> = [];
	// Buffer images from toolResult entries to attach to the next assistant message
	let pendingImages: Array<{ data: string; mimeType: string }> = [];

	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "compaction") {
			// Show compacted history as a summary message
			const ce = e as any;
			if (ce.summary) {
				messages.push({ role: "assistant", content: ce.summary });
			}
		}
		if (e.type === "custom_message") {
			const cm = e as any;
			if (cm.display && cm.content) {
				const text = typeof cm.content === "string"
					? cm.content
					: (Array.isArray(cm.content) ? cm.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") : "");
				if (text.trim()) messages.push({ role: "assistant", content: text.trim() });
			}
		}
		if (e.type !== "message") continue;
		const msg = e.message;
		if ((msg.role as string) === "toolResult") {
			// Extract image blocks from tool results
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if ((block as any).type === "image" && (block as any).data) {
						pendingImages.push({ data: (block as any).data, mimeType: (block as any).mimeType || "image/png" });
					}
				}
			}
			// Cap at 5 images per tool result to avoid bloating
			if (pendingImages.length > 5) pendingImages = pendingImages.slice(-5);
		} else if (msg.role === "user") {
			let text = "";
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if ((block as any).type === "text") text += (block as any).text;
				}
			} else if (typeof msg.content === "string") {
				text = msg.content;
			}
			if (text.trim()) messages.push({ role: "user", content: text.trim() });
		} else if (msg.role === "assistant") {
			let text = "";
			const toolCalls: Array<{ role: string; content: string; toolName?: string }> = [];
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if ((block as any).type === "text") text += (block as any).text;
					else if ((block as any).type === "tool_use") {
						toolCalls.push({ role: "tool", content: JSON.stringify((block as any).input || {}, null, 2).slice(0, 300), toolName: (block as any).name });
					}
				}
			} else if (typeof msg.content === "string") {
				text = msg.content;
			}
			// Add tool calls before the text response
			messages.push(...toolCalls);
			if (text.trim()) {
				const assistMsg: typeof messages[0] = { role: "assistant", content: text.trim() };
				// Attach buffered images from preceding toolResult
				if (pendingImages.length > 0) {
					assistMsg.images = pendingImages;
					pendingImages = [];
				}
				messages.push(assistMsg);
			}
		}
	}
	return messages;
}

function extractThreadMessages(filePath: string) {
	const messages: Array<{ role: string; content: string; toolName?: string; images?: Array<{ data: string; mimeType: string }> }> = [];
	let pendingImages: Array<{ data: string; mimeType: string }> = [];
	try {
		const content = readFileSync(filePath, "utf-8");
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (entry.type === "compaction" && entry.summary) {
					messages.push({ role: "assistant", content: entry.summary });
					continue;
				}
				if (entry.type === "custom_message" && entry.display && entry.content) {
					const text = typeof entry.content === "string"
						? entry.content
						: (Array.isArray(entry.content) ? entry.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("") : "");
					if (text.trim()) messages.push({ role: "assistant", content: text.trim() });
					continue;
				}
				if (entry.type !== "message") continue;
				const msg = entry.message;
				if (msg?.role === "toolResult") {
					// Extract image blocks from tool results
					if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "image" && block.data) {
								pendingImages.push({ data: block.data, mimeType: block.mimeType || "image/png" });
							}
						}
					}
					if (pendingImages.length > 5) pendingImages = pendingImages.slice(-5);
				} else if (msg?.role === "user") {
					let text = "";
					if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "text") text += block.text;
						}
					} else if (typeof msg.content === "string") text = msg.content;
					if (text.trim()) messages.push({ role: "user", content: text.trim() });
				} else if (msg?.role === "assistant") {
					let text = "";
					const toolCalls: typeof messages = [];
					if (Array.isArray(msg.content)) {
						for (const block of msg.content) {
							if (block.type === "text") text += block.text;
							else if (block.type === "tool_use") {
								toolCalls.push({ role: "tool", content: JSON.stringify(block.input || {}, null, 2).slice(0, 300), toolName: block.name });
							}
						}
					} else if (typeof msg.content === "string") text = msg.content;
					messages.push(...toolCalls);
					if (text.trim()) {
						const assistMsg: typeof messages[0] = { role: "assistant", content: text.trim() };
						if (pendingImages.length > 0) {
							assistMsg.images = pendingImages;
							pendingImages = [];
						}
						messages.push(assistMsg);
					}
				}
			} catch {}
		}
	} catch {}
	return messages;
}

function getDirEntries(dir: string) {
	try {
		return readdirSync(dir)
			.filter(f => !f.startsWith(".") && f !== "node_modules" && f !== "__pycache__")
			.map(f => {
				try {
					const stat = statSync(join(dir, f));
					return { name: f, isDir: stat.isDirectory(), size: stat.isDirectory() ? "" : formatSize(stat.size), path: join(dir, f) };
				} catch { return { name: f, isDir: false, size: "", path: join(dir, f) }; }
			})
			.sort((a, b) => {
				if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
				return a.name.localeCompare(b.name);
			});
	} catch { return []; }
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)}K`;
	return `${(bytes / 1048576).toFixed(1)}M`;
}

/** Escape non-ASCII chars to \uXXXX so only ASCII bytes pass through Glimpse's
 *  Windows webview bridge — prevents UTF-8 → CP1252 mojibake (e.g. — → ΓÇö). */
function escapeNonAscii(str: string): string {
	return str.replace(/[^\x00-\x7F]/g, (ch) =>
		`\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// ─── HTML Builder ────────────────────────────────────────────

interface DesktopWindowData {
	projectName: string;
	gitBranch: string | null;
	model: string;
	thinkingLevel: string;
	provider: string;
	cwd: string;
	stats: { input: number; output: number; cache: number; cost: number };
	threads: Array<{ name: string; file: string; date: string }>;
	skills: Array<{ name: string; desc: string }>;
	extensions: Array<{ name: string; source: string; type: string }>;
	workspaces: Array<{ name: string; path: string; dirName: string; sessionCount: number; lastActive: string }>;
	messages: Array<{ role: string; content: string; toolName?: string; images?: Array<{ data: string; mimeType: string }> }>;
	explorerFiles: Array<{ name: string; isDir: boolean; size: string; path: string }>;
	commands: Array<{ name: string; description: string; source: string; scope: string; path: string }>;
	hiddenWorkspaces: Record<string, boolean>;
}

function buildDesktopHtml(data: DesktopWindowData): string {
	const templateHtml = readFileSync(join(webDir, "index.html"), "utf8");
	const appJs = readFileSync(join(webDir, "app.js"), "utf8");

	// Base64-encode JSON to avoid Glimpse webview bridge corruption.
	// The bridge (about:blank + WebView2 on Windows) can corrupt control characters
	// and \uXXXX escapes during transfer. Base64 is pure alphanumeric + /+= and
	// survives any encoding conversion.
	const rawJson = JSON.stringify(data);
	let base64Json = Buffer.from(rawJson, 'utf8').toString('base64');

	// Safety: WebView2 NavigateToString has a hard 2MB limit.
	// If the full HTML would exceed it, strip messages from data and retry.
	const staticSize = templateHtml.length + appJs.length - "__INLINE_DATA__".length - "__INLINE_JS__".length;
	const MAX_HTML_SIZE = 1_900_000; // leave 100KB headroom under 2MB
	if (staticSize + base64Json.length > MAX_HTML_SIZE) {
		data.messages = data.messages.slice(-10);
		const fallbackJson = JSON.stringify(data);
		base64Json = Buffer.from(fallbackJson, 'utf8').toString('base64');
	}

	// Use split+join instead of .replace() to avoid $-pattern interpretation
	let result = templateHtml.split("__INLINE_DATA__").join(base64Json);
	result = result.split("__INLINE_JS__").join(appJs);
	return result;
}

// ─── Extension Entry Point ───────────────────────────────────

export default function desktopTuiExtension(pi: ExtensionAPI) {
	let projectName = "";
	let gitBranch: string | null = null;
	let activeWindow: GlimpseWindow | null = __piDesktop.window;
	let lastCtx: ExtensionContext | null = null;
	let lastCommandCtx: ExtensionCommandContext | null = null;
	let activeExplorerCwd: string | null = null; // override CWD when viewing another workspace
	let sessionReason: string = "startup";
	let sessionTransitioning = false; // true while a session switch is in progress (prevents window close)
	let planMode: boolean = false;
	let pendingDesktopUserMessage: boolean = false; // true when a user message originated from the desktop UI (suppresses steer-message echo)
	let pendingResponseImages: Array<{ data: string; mimeType: string }> = []; // images from tool results to attach to next assistant response

	const PLAN_MODE_PREFIX = `[PLAN MODE ACTIVE — You are in read-only plan mode. STRICT RULES:
1. Do NOT use edit, write, or any tool that modifies files
2. Do NOT run bash commands that create, modify, or delete files (no mkdir, rm, mv, cp, touch, tee, sed -i, etc.)
3. ONLY use: read, grep, find, ls, parallel_search, parallel_research, parallel_extract, todo, subagent (scout only)
4. Safe bash allowed: git log, git diff, git status, cat, head, tail, wc, echo, pwd, env, which, type
5. Focus on: reading code, analyzing architecture, creating plans, reviewing scaffolding, identifying patterns
6. If the user asks you to write or edit, remind them Plan Mode is active and suggest they turn it off first]

`;

	// ─── Window Communication ─────────────────────────────────

	function setActiveWindow(win: GlimpseWindow | null): void {
		activeWindow = win;
		__piDesktop.window = win;
	}

	function sendToWindow(message: any): void {
		if (!activeWindow) return;
		try {
			// Double-stringify: JSON.stringify creates a safe JS string literal,
			// JSON.parse in the webview decodes it. escapeNonAscii ensures only
			// ASCII bytes pass through Glimpse's send() — prevents UTF-8 → CP1252
			// mojibake on Windows (e.g. em dash — rendered as ΓÇö).
			const jsonStr = JSON.stringify(message);
			const js = `window.__desktopReceive(JSON.parse(${JSON.stringify(jsonStr)}))`;
			activeWindow.send(escapeNonAscii(js));
		} catch {}
	}

	function closeActiveWindow(): void {
		if (activeWindow == null) return;
		const w = activeWindow;
		setActiveWindow(null);
		try { w.close(); } catch {}
		// Clear custom thinking label when desktop window closes
		try { lastCtx?.ui?.setHiddenThinkingLabel?.(undefined as any); } catch {}
	}

	// ─── Streaming Event Handlers (global) ────────────────────

	pi.on("agent_start", (_event, _ctx) => {
		pendingResponseImages = []; // clear any stale images from previous turn
		sendToWindow({ type: "agent-start" });
	});

	pi.on("agent_end", (_event, ctx) => {
		lastCtx = ctx;
		const stats = getTokenStats(ctx);
		sendToWindow({ type: "agent-end" });
		sendToWindow({ type: "stats-update", stats });
	});

	pi.on("message_start", (event, _ctx) => {
		const msg = event.message;
		if (msg.role === "assistant") {
			sendToWindow({ type: "message-start", role: "assistant" });
		} else if (msg.role === "user") {
			// Skip forwarding user messages that originated from the desktop UI
			// (the frontend already added them locally — forwarding would cause duplicates).
			if (pendingDesktopUserMessage) {
				pendingDesktopUserMessage = false;
				return;
			}
			// Forward user messages from steers (e.g. subagent completion)
			// to the desktop window so they appear in the chat.
			let text = "";
			if (typeof msg.content === "string") {
				text = msg.content;
			} else if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if ((block as any).type === "text") text += (block as any).text;
				}
			}
			if (text) {
				sendToWindow({ type: "steer-message", content: text });
			}
		}
	});

	pi.on("message_update", (event, _ctx) => {
		const evt = event.assistantMessageEvent as any;
		switch (evt.type) {
			case "text_delta":
				sendToWindow({ type: "message-chunk", text: evt.delta });
				break;
			case "text_start":
				sendToWindow({ type: "message-chunk-start" });
				break;
			case "text_end":
				sendToWindow({ type: "message-chunk-end", content: evt.content });
				break;
			case "thinking_delta":
				sendToWindow({ type: "thinking-chunk", text: evt.delta });
				break;
			case "thinking_start":
				sendToWindow({ type: "thinking-start" });
				break;
			case "thinking_end":
				sendToWindow({ type: "thinking-end" });
				break;
			case "toolcall_start":
				sendToWindow({ type: "toolcall-stream-start", contentIndex: evt.contentIndex });
				break;
			case "toolcall_end":
				sendToWindow({ type: "toolcall-stream-end", contentIndex: evt.contentIndex, toolName: evt.toolCall?.name });
				break;
		}
	});

	pi.on("message_end", (event, ctx) => {
		lastCtx = ctx;
		const msg = event.message;
		if (msg.role === "assistant") {
			let text = "";
			if (Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if ((block as any).type === "text") text += (block as any).text;
				}
			}
			// Attach any buffered images from tool results to the assistant response
			const images = pendingResponseImages.length > 0 ? pendingResponseImages.splice(0) : undefined;
			sendToWindow({ type: "message-end", role: "assistant", content: text, images });
		}
	});

	pi.on("tool_execution_start", (event, _ctx) => {
		// Warn in desktop window if a write tool fires during plan mode
		if (planMode) {
			const writeTools = new Set(["edit", "write", "claude"]);
			if (writeTools.has(event.toolName) || (event.toolName === "bash" && event.args?.command)) {
				sendToWindow({
					type: "plan-mode-violation",
					toolName: event.toolName,
					argsPreview: JSON.stringify(event.args || {}).slice(0, 200),
				});
			}
		}

		// Format args for display
		let argsDisplay = "";
		let editDiffs: Array<{ oldText: string; newText: string }> | null = null;
		let editPath = "";
		try {
			const args = event.args;
			if (event.toolName === "bash" && args?.command) {
				argsDisplay = args.command;
			} else if (event.toolName === "read" && args?.path) {
				argsDisplay = `read ${args.path}` + (args.offset ? ` (offset: ${args.offset})` : "");
			} else if (event.toolName === "edit" && args?.path) {
				editPath = args.path;
				// Handle both formats: edits[] array (normal) and legacy top-level oldText/newText
				let edits: Array<{oldText: string; newText: string}> = Array.isArray(args.edits) ? args.edits : [];
				if (edits.length === 0 && typeof args.oldText === "string" && typeof args.newText === "string") {
					edits = [{ oldText: args.oldText, newText: args.newText }];
				}
				editDiffs = edits.map((e: any) => ({
					oldText: e.oldText || "",
					newText: e.newText || "",
				}));
				argsDisplay = `edit ${args.path} (${edits.length} edit(s))`;
			} else if (event.toolName === "write" && args?.path) {
				argsDisplay = `write ${args.path}`;
			} else if (event.toolName === "grep" && args?.pattern) {
				argsDisplay = `grep "${args.pattern}"` + (args.path ? ` in ${args.path}` : "");
			} else if (event.toolName === "find" && args?.path) {
				argsDisplay = `find ${args.path}` + (args.glob ? ` -name ${args.glob}` : "");
			} else if (event.toolName === "ls" && args?.path) {
				argsDisplay = `ls ${args.path}`;
			} else {
				argsDisplay = JSON.stringify(args || {}, null, 2).slice(0, 500);
			}
		} catch { argsDisplay = "..."; }

		// For edit tools, encode diffs as a flat base64 string to survive Glimpse bridge
		const editDiffsB64 = editDiffs ? Buffer.from(JSON.stringify(editDiffs)).toString("base64") : "";

		sendToWindow({
			type: "tool-start",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			argsDisplay,
			editDiffsB64,
			editPath,
		});
	});

	pi.on("model_select", (event, _ctx) => {
		// Update desktop window immediately when user switches model (Ctrl+P, /model)
		sendToWindow({
			type: "provider-request",
			model: event.model?.id ?? "",
			provider: (event.model as any)?.provider ?? "",
		});
	});

	pi.on("before_provider_request", ((event: any, _ctx: ExtensionContext) => {
		// Forward provider request metadata to desktop window for real-time model/provider display
		sendToWindow({
			type: "provider-request",
			model: event.model ?? "",
			provider: event.provider ?? "",
		});
	}) as any);

	pi.on("tool_execution_end", (event, _ctx) => {
		// Extract result text and images
		let resultText = "";
		let resultImages: Array<{ data: string; mimeType: string }> = [];
		try {
			const result = event.result;
			if (typeof result === "string") {
				resultText = result;
			} else if (result?.content) {
				// AgentToolResult has content array
				if (Array.isArray(result.content)) {
					resultText = result.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n");
					// Extract image content blocks
					for (const block of result.content) {
						if ((block as any).type === "image" && (block as any).data) {
							resultImages.push({
								data: (block as any).data,
								mimeType: (block as any).mimeType || "image/png",
							});
						}
					}
				} else if (typeof result.content === "string") {
					resultText = result.content;
				}
			} else if (result != null) {
				resultText = JSON.stringify(result, null, 2);
			}
		} catch { resultText = "(result unavailable)"; }

		// Buffer images for the next assistant response
		if (resultImages.length > 0) {
			pendingResponseImages.push(...resultImages.slice(0, 5));
		}

		sendToWindow({
			type: "tool-end",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			isError: event.isError,
			resultText: resultText.slice(0, 3000),
			resultImages: resultImages.slice(0, 5),
		});
	});

	// NOTE: Removed input mirroring - it caused duplicate messages.
	// The window adds user messages locally when sent from the window.
	// Terminal messages appear via the streaming events (message_start/end).

	// ─── Window Message Handler ───────────────────────────────

	function handleWindowMessage(msg: any): void {
		if (!msg || typeof msg !== "object") return;

		switch (msg.type) {
			case "send-message": {
				const text = (msg.text || "").trim();
				if (!text || text.length > 100_000) break;
				if (text.startsWith("/")) {
					// Slash command from desktop UI.
					// 1. Show desktop card for commands we can render natively
					// 2. ALWAYS inject into terminal so the real command executes there too
					const ctx = lastCommandCtx;
					if (ctx) {
						try { showDesktopCard(text, ctx); } catch {}
					}
					injectIntoTerminal(text);
				} else {
					const finalText = planMode ? PLAN_MODE_PREFIX + text : text;
					pendingDesktopUserMessage = true;
					try {
						pi.sendUserMessage(finalText);
					} catch (err) {
						pendingDesktopUserMessage = false;
						sendToWindow({ type: "command-result", command: "send-message", success: false, message: "Session context expired — please resend your message." });
					}
				}
				break;
			}

			case "open-thread": {
				if (msg.file && isValidSessionFile(msg.file)) {
					const threadMsgs = extractThreadMessages(msg.file);
					sendToWindow({ type: "thread-messages", messages: threadMsgs, threadIdx: msg.index ?? 0 });
					// Switch explorer CWD when viewing another workspace's thread
					if (msg.workspace && typeof msg.workspace === "string" && msg.workspace !== "__current__") {
						const decodedPath = decodeSessionDirName(msg.workspace);
						if (existsSync(decodedPath)) {
							activeExplorerCwd = decodedPath;
						}
					} else {
						activeExplorerCwd = null; // back to current workspace
					}
				}
				break;
			}

			case "nav": {
				if (msg.action === "explorer") {
					const cwd = activeExplorerCwd || lastCtx?.cwd;
					if (cwd) {
						const files = getDirEntries(cwd);
						sendToWindow({ type: "explorer-data", files });
						sendToWindow({ type: "explorer-tree-children", parentPath: cwd, children: files });
					}
				}
				break;
			}

			case "explorer-tree-expand": {
				// Expand a directory in the sidebar tree
				const explorerCtx = activeExplorerCwd ? { cwd: activeExplorerCwd } : lastCtx;
				if (msg.path && isPathAllowed(msg.path, explorerCtx)) {
					try {
						const stat = statSync(msg.path);
						if (stat.isDirectory()) {
							const children = getDirEntries(msg.path);
							sendToWindow({ type: "explorer-tree-children", parentPath: msg.path, children });
						}
					} catch {}
				}
				break;
			}

			case "explorer-open": {
				const openCtx = activeExplorerCwd ? { cwd: activeExplorerCwd } : lastCtx;
				if (msg.path && isPathAllowed(msg.path, openCtx)) {
					try {
						const stat = statSync(msg.path);
						if (stat.isDirectory()) {
							const files = getDirEntries(msg.path);
							sendToWindow({ type: "explorer-data", files });
						} else if (stat.isFile()) {
							// Images and binaries → open with system default app
							const imageExts = new Set(["png","jpg","jpeg","gif","bmp","svg","webp","ico","tiff","tif"]);
							const binaryExts = new Set(["pdf","doc","docx","xls","xlsx","ppt","pptx","zip","tar","gz","exe","dll","so","dylib","mp3","mp4","mov","avi","wav"]);
							const ext = extname(msg.path).slice(1).toLowerCase();
							if (imageExts.has(ext) || binaryExts.has(ext)) {
								// Open with system default app
								const escapedPath = msg.path.replace(/"/g, '\\"');
								const cmd = process.platform === "win32" ? `start "" "${escapedPath}"`
									: process.platform === "darwin" ? `open "${escapedPath}"`
									: `xdg-open "${escapedPath}"`;
								exec(cmd);
							} else {
								// Text file → read and send content
								const MAX_FILE_SIZE = 512 * 1024;
								if (stat.size > MAX_FILE_SIZE) {
									sendToWindow({ type: "file-content", path: msg.path, name: basename(msg.path), ext, content: null, error: `File too large (${(stat.size / 1024).toFixed(0)}KB). Max: 512KB.`, size: stat.size });
								} else {
									const content = readFileSync(msg.path, "utf8");
									sendToWindow({ type: "file-content", path: msg.path, name: basename(msg.path), ext, content, size: stat.size });
								}
							}
						}
					} catch {}
				}
				break;
			}

			case "get-commands": {
				sendToWindow({ type: "commands-list", commands: getAllCommands(pi) });
				break;
			}

			case "get-stats": {
				if (lastCtx) {
					const stats = getTokenStats(lastCtx);
					sendToWindow({ type: "stats-update", stats });
				}
				break;
			}

			case "refresh-threads": {
				if (lastCtx) {
					const sessionFile = (lastCtx.sessionManager as any).getSessionFile?.() ?? null;
					const sessionDir = sessionFile ? join(sessionFile, "..") : null;
					const threads = getSessionThreads(sessionDir).map(t => ({
						name: t.name, file: t.file, date: t.date.toISOString(),
					}));
					sendToWindow({ type: "update-threads", threads });
				}
				break;
			}

			case "refresh-skills": {
				const skills = getSkills();
				const extensions = getExtensions();
				sendToWindow({ type: "update-skills", skills, extensions });
				break;
			}

			case "get-workspaces": {
				const wsList = getWorkspaces().map(w => ({
					...w, lastActive: w.lastActive.toISOString(),
				}));
				sendToWindow({ type: "workspaces-list", workspaces: wsList });
				break;
			}

			case "get-workspace-sessions": {
				if (msg.dirName) {
					const sessions = getWorkspaceSessions(msg.dirName).map(t => ({
						name: t.name, file: t.file, date: t.date.toISOString(),
					}));
					sendToWindow({ type: "workspace-sessions", dirName: msg.dirName, sessions });
				}
				break;
			}

			case "search-threads": {
				if (msg.query && typeof msg.query === "string" && msg.query.length >= 2 && msg.query.length <= 200) {
					const query = msg.query;
					const allResults: Array<{ name: string; file: string; date: string; matchSnippet: string; workspace: string }> = [];

					// Search current workspace
					if (lastCtx) {
						const sessionFile = (lastCtx.sessionManager as any).getSessionFile?.() ?? null;
						const sessionDir = sessionFile ? join(sessionFile, "..") : null;
						const results = searchSessionThreads(sessionDir, query);
						for (const r of results) {
							allResults.push({ name: r.name, file: r.file, date: r.date.toISOString(), matchSnippet: r.matchSnippet, workspace: "__current__" });
						}
					}

					// Search other workspaces
					const home = process.env.HOME || process.env.USERPROFILE || "";
					const sessionsRoot = join(home, ".pi", "agent", "sessions");
					const cwd = lastCtx ? (lastCtx as any).cwd || "" : "";
					const workspaces = getWorkspaces().filter(w => w.path !== cwd);
					for (const ws of workspaces) {
						const wsDir = join(sessionsRoot, ws.dirName);
						const results = searchSessionThreads(wsDir, query);
						for (const r of results) {
							allResults.push({ name: r.name, file: r.file, date: r.date.toISOString(), matchSnippet: r.matchSnippet, workspace: ws.dirName });
						}
					}

					sendToWindow({ type: "search-results", query, results: allResults });
				}
				break;
			}

			case "open-folder-path": {
				if (msg.path && typeof msg.path === "string" && msg.path.length < 1000) {
					// Reject path traversal attempts
					if (msg.path.includes("..")) break;

					const folderPath = msg.path.replace(/\\/g, "/").replace(/\/$/, "");
					// Encode path to session dir name format
					const safePath = `--${folderPath.replace(/^\//, "").replace(/[\/\\:]/g, "-")}--`;
					const home = process.env.HOME || process.env.USERPROFILE || "";
					const sessionsRoot = join(home, ".pi", "agent", "sessions");
					const sessionDir = join(sessionsRoot, safePath);

					// Verify the session dir is actually under sessions root (prevent traversal via crafted safePath)
					const resolvedSessionDir = resolve(normalize(sessionDir));
					const resolvedSessionsRoot = resolve(sessionsRoot);
					if (!resolvedSessionDir.startsWith(resolvedSessionsRoot + "/") && !resolvedSessionDir.startsWith(resolvedSessionsRoot + "\\")) break;

					if (existsSync(sessionDir)) {
						// Workspace exists - expand it in sidebar
						const sessions = getSessionThreads(sessionDir).map(t => ({
							name: t.name, file: t.file, date: t.date.toISOString(),
						}));
						sendToWindow({ type: "workspace-opened", dirName: safePath, path: msg.path, sessions });
					} else {
						// No sessions for this path yet
						sendToWindow({ type: "workspace-opened", dirName: safePath, path: msg.path, sessions: [] });
					}
					// Update explorer CWD to the opened folder if it exists on disk
					const resolvedFolder = resolve(normalize(msg.path));
					if (existsSync(resolvedFolder)) {
						activeExplorerCwd = resolvedFolder;
					}
				}
				break;
			}

			case "set-plan-mode": {
				planMode = msg.active === true;
				if (lastCtx) {
					lastCtx.ui.notify(
						planMode
							? "Plan Mode ON — pi will only read, search, and analyze. No writes."
							: "Plan Mode OFF — full access restored.",
						"info"
					);
				}
				break;
			}

			case "close": {
				closeActiveWindow();
				break;
			}

			case "attach-file": {
				const name = msg.name || "file";
				const mimeType = msg.mimeType || "application/octet-stream";
				const base64 = msg.base64;
				if (!base64) break;

				// Reject oversized attachments (base64 is ~4/3 of original)
				if (base64.length > MAX_ATTACH_SIZE * 1.37) {
					sendToWindow({ type: "file-attached-ack", path: "", name, error: "File too large (max 25MB)" });
					break;
				}

				try {
					const ext = extname(name) || (mimeType.startsWith("image/") ? "." + (mimeType.split("/")[1] || "png") : ".bin");
					// Sanitize filename: strip path separators, restrict to safe characters
					const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, "").slice(0, 10);
					const fileName = `pi-attach-${randomUUID()}${safeExt}`;
					const filePath = join(tmpdir(), fileName);
					writeFileSync(filePath, Buffer.from(base64, "base64"));
					sendToWindow({ type: "file-attached-ack", path: filePath, name });
				} catch (e) {
					sendToWindow({ type: "file-attached-ack", path: "", name, error: String(e) });
				}
				break;
			}

			case "cancel-streaming": {
				if (lastCtx && !lastCtx.isIdle()) {
					lastCtx.abort();
				}
				break;
			}

			case "set-hidden-workspaces": {
				if (msg.hiddenWorkspaces && typeof msg.hiddenWorkspaces === "object") {
					// Validate shape: must be Record<string, boolean> — reject anything else
					const sanitized: Record<string, boolean> = {};
					for (const [key, val] of Object.entries(msg.hiddenWorkspaces)) {
						if (typeof key === "string" && typeof val === "boolean" && key.length < 500) {
							sanitized[key] = val;
						}
					}
					saveHiddenWorkspaces(sanitized);
				}
				break;
			}

			case "launch-workspace": {
				if (msg.path && typeof msg.path === "string" && msg.path.length < 1000 && !msg.path.includes("..")) {
					const targetPath = resolve(normalize(msg.path));
					// Only launch if the directory exists
					try {
						if (existsSync(targetPath) && statSync(targetPath).isDirectory()) {
							const child = spawn("pi", [], {
								cwd: targetPath,
								detached: true,
								stdio: "ignore",
								shell: true,
							});
							child.unref();
						}
					} catch { /* ignore spawn errors */ }
				}
				break;
			}

		}
	}

	// ─── Open Window ──────────────────────────────────────────

	function collectWindowData(ctx: ExtensionContext): DesktopWindowData {
		const stats = getTokenStats(ctx);
		const model = ctx.model?.id || "no-model";
		const thinkingLevel = pi.getThinkingLevel();
		const sessionFile = (ctx.sessionManager as any).getSessionFile?.() ?? null;
		const sessionDir = sessionFile ? join(sessionFile, "..") : null;
		const threads = getSessionThreads(sessionDir).map(t => ({
			name: t.name, file: t.file, date: t.date.toISOString(),
		}));
		const skills = getSkills();
		const extensions = getExtensions();
		const allWorkspaces = getWorkspaces().map(w => ({
			...w, lastActive: w.lastActive.toISOString(),
		}));
		// Cap initial messages to prevent WebView2 NavigateToString 2MB limit crash.
		// The 2MB limit applies to the full HTML (template + app.js + base64 data).
		// Budget: ~1.2MB for message JSON (after base64 inflate ≈ 1.6MB, plus ~155KB static).
		const MAX_MSG_CHARS = 8000; // truncate individual message content
		const MAX_JSON_BYTES = 1_200_000; // total budget for messages JSON
		const allMessages = extractSessionMessages(ctx);
		let messages = allMessages.slice(-50).map(m => ({
			...m,
			// Strip images from initial load — they bloat base64 payload massively
			images: undefined,
			content: m.content.length > MAX_MSG_CHARS
				? m.content.slice(0, MAX_MSG_CHARS) + "\n…(truncated)"
				: m.content,
		}));
		// If still too large, progressively drop oldest messages
		while (messages.length > 5 && JSON.stringify(messages).length > MAX_JSON_BYTES) {
			messages = messages.slice(Math.ceil(messages.length * 0.25));
		}
		const explorerFiles = getDirEntries(ctx.cwd);
		const commands = getAllCommands(pi);

		return {
			projectName, gitBranch, model, thinkingLevel,
			provider: (ctx.model as any)?.provider || "unknown",
		cwd: ctx.cwd, stats, threads, skills, extensions, workspaces: allWorkspaces, messages, explorerFiles, commands,
			hiddenWorkspaces: loadHiddenWorkspaces(),
		};
	}

	function openDesktopWindow(ctx: ExtensionContext): void {
		if (activeWindow != null) {
			ctx.ui.notify("Desktop window is already open.", "warning");
			return;
		}

		lastCtx = ctx;
		const data = collectWindowData(ctx);
		const html = buildDesktopHtml(data);
		const win = open(html, {
			width: 1400,
			height: 900,
			title: "pi Desktop",
		});
		setActiveWindow(win);

		// Customize thinking block label while desktop window is open (v0.64.0)
		try { ctx.ui.setHiddenThinkingLabel?.("thinking (visible in Desktop ◈)"); } catch {}

		win.on("message", handleWindowMessage);
		win.on("closed", () => {
			if (activeWindow === win) setActiveWindow(null);
		});
		win.on("error", () => {
			if (activeWindow === win) setActiveWindow(null);
		});

		ctx.ui.notify("Pi Desktop window opened. Chat from here or the window — both are synced.", "info");
	}

	// ─── Custom Footer ────────────────────────────────────────

	function enableFooter(ctx: ExtensionContext) {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch();
					gitBranch = branch;
					const stats = getTokenStats(ctx);
					const model = ctx.model?.id || "no-model";
					const windowIndicator = activeWindow ? theme.fg("accent", " ◈") : "";

					const left = ` ${theme.fg("text", theme.bold(projectName))}${theme.fg("dim", " / ")}${branch ? theme.fg("accent", branch) : theme.fg("dim", "local")}${theme.fg("dim", " / ")}${theme.fg("dim", model)}${windowIndicator}`;
					const right = theme.fg("dim", `In ${fmt(stats.input)}  Out ${fmt(stats.output)}  Cache ${fmt(stats.cache)}  $${stats.cost.toFixed(4)}`);
					const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
					return [truncateToWidth(left + pad + right, width)];
				},
			};
		});
	}

	// ─── Context Widget ───────────────────────────────────────

	function enableWidget(ctx: ExtensionContext) {
		ctx.ui.setWidget("desktop-context", (_tui, theme) => ({
			render: () => [
				theme.fg("dim", " ───") + " " + theme.fg("text", `◈ ${projectName}`) + theme.fg("dim", " / ") + theme.fg("accent", gitBranch || "local") + " " + theme.fg("dim", "─".repeat(30))
			],
			invalidate: () => {},
		}));
	}

	// ─── CLI Flag ─────────────────────────────────────────────

	pi.registerFlag("desktop", {
		description: "Auto-open Pi Desktop UI on startup",
		type: "boolean",
		default: false,
	});

	// ─── Commands ─────────────────────────────────────────────

	pi.registerCommand("desktop", {
		description: "Open pi Desktop window (fully functional chat UI)",
		handler: async (_args, ctx) => {
			lastCommandCtx = ctx;
			openDesktopWindow(ctx);
		},
	});

	pi.registerCommand("nav", {
		description: "Open pi Desktop navigation window",
		handler: async (_args, ctx) => {
			lastCommandCtx = ctx;
			openDesktopWindow(ctx);
		},
	});

	// ─── Slash Command Dispatch for Desktop UI ───────────────
	// pi.sendUserMessage() skips slash command dispatch (expandPromptTemplates: false).
	// We handle commands programmatically via ExtensionCommandContext and ExtensionAPI,
	// then send results back to the desktop window so the user gets visual feedback.
	// Commands we can't handle go through the terminal via injectIntoTerminal().

	/** Send a command result/feedback message to the desktop window. */
	function sendCommandResult(command: string, opts: { success?: boolean; message?: string }) {
		sendToWindow({
			type: "command-result",
			command,
			success: opts.success ?? true,
			message: opts.message || "",
		});
	}


	/** Show a desktop info card for commands we can render natively.
	 *  Display-only — actual execution always happens via injectIntoTerminal(). */
	function showDesktopCard(text: string, ctx: ExtensionContext): void {
		if (!text.startsWith("/")) return;
		const spaceIdx = text.indexOf(" ", 1);
		const cmdName = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
		const cmdArgs = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

		switch (cmdName) {
			case "session": {
				const stats = getTokenStats(ctx);
				const sessionFile = (ctx.sessionManager as any).getSessionFile?.() ?? "ephemeral";
				const entryCount = ctx.sessionManager.getEntries().length;
				const branchLen = ctx.sessionManager.getBranch().length;
				const model = ctx.model?.id || "no model";
				const sessionName = pi.getSessionName();
				const lines = [
					`**Session Info**`,
					sessionName ? `Name: ${sessionName}` : null,
					`Model: ${model}`,
					`Entries: ${entryCount} (branch: ${branchLen})`,
					`Input: ${fmt(stats.input)} · Output: ${fmt(stats.output)} · Cache: ${fmt(stats.cache)}`,
					`Cost: $${stats.cost.toFixed(4)}`,
					`File: ${basename(sessionFile)}`,
				].filter(Boolean).join("\n");
				sendCommandResult("session", { message: lines });
				break;
			}

			case "hotkeys": {
				const shortcuts = [
					"Ctrl+C — Cancel / clear input",
					"Ctrl+D — Quit pi",
					"Ctrl+P — Cycle model",
					"Ctrl+L — Clear terminal",
					"Ctrl+Alt+N — Open Desktop window",
					"Escape — Cancel streaming",
					"Tab — Accept autocomplete",
					"Up/Down — History navigation",
					"Shift+Enter — Newline in editor",
				];
				sendCommandResult("hotkeys", { message: "**Keyboard Shortcuts**\n" + shortcuts.join("\n") });
				break;
			}

			case "context": {
				const usage = ctx.getContextUsage();
				const model = ctx.model;
				if (!usage || !model) {
					sendCommandResult("context", { success: false, message: "No context usage data available. Send a message first." });
					break;
				}
				const contextWindow = usage.contextWindow;
				const usedTokens = usage.tokens;
				const maxOutputTokens = model.maxTokens || 0;
				let systemToolsTokens = 0, messageTokens = 0;
				const entries = ctx.sessionManager.getBranch();
				let lastUsage: any = null;
				for (let i = entries.length - 1; i >= 0; i--) {
					const entry = entries[i];
					if (entry.type === "message" && entry.message.role === "assistant") {
						const a = entry.message as any;
						if (a.stopReason !== "aborted" && a.stopReason !== "error" && a.usage) { lastUsage = a.usage; break; }
					}
				}
				if (lastUsage && usedTokens !== null) {
					const cacheTokens = (lastUsage.cacheRead || 0) + (lastUsage.cacheWrite || 0);
					if (cacheTokens > 0) { systemToolsTokens = cacheTokens; messageTokens = Math.max(0, usedTokens - cacheTokens); }
					else { systemToolsTokens = Math.round(usedTokens * 0.15); messageTokens = usedTokens - systemToolsTokens; }
				} else if (usedTokens !== null) {
					systemToolsTokens = Math.round(usedTokens * 0.15); messageTokens = usedTokens - systemToolsTokens;
				}
				const bufferTokens = maxOutputTokens;
				const freeTokens = usedTokens !== null ? Math.max(0, contextWindow - usedTokens - bufferTokens) : contextWindow - bufferTokens;
				const pct = (n: number) => contextWindow > 0 ? ((n / contextWindow) * 100).toFixed(0) : "0";
				const modelName = model.id || (model as any).name || "unknown";
				const percentStr = usage.percent !== null ? `${Math.round(usage.percent!)}%` : "?%";
				const usedStr = usedTokens !== null ? fmt(usedTokens) : "?";
				sendCommandResult("context", { message: [
					`**Context Usage**`, ``,
					`${modelName}  ·  ${usedStr} / ${fmt(contextWindow)} tokens (${percentStr})`, ``,
					`◍ System/Tools: ${fmt(systemToolsTokens).padStart(7)} (${pct(systemToolsTokens)}%)`,
					`● Messages:     ${fmt(messageTokens).padStart(7)} (${pct(messageTokens)}%)`,
					`· Free Space:   ${fmt(Math.max(0, freeTokens)).padStart(7)} (${pct(Math.max(0, freeTokens))}%)`,
					`○ Buffer:       ${fmt(bufferTokens).padStart(7)} (${pct(bufferTokens)}%)`,
				].join("\n") });
				break;
			}

			case "cost": {
				const days = cmdArgs ? parseInt(cmdArgs, 10) : 7;
				if (isNaN(days) || days < 1) { sendCommandResult("cost", { success: false, message: "Usage: /cost [days]" }); break; }
				const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - days);
				const cutoffStr = cutoff.toISOString().slice(0, 10);
				const home = process.env.HOME || process.env.USERPROFILE || "";
				const sessionsDir = join(home, ".pi", "agent", "sessions");
				const tmpDir = process.env.TMPDIR || (process.platform === "win32" ? process.env.TEMP || "C:\Temp" : "/tmp");
				let mainCost = 0, subCost = 0, mainSessions = 0, subSessions = 0;
				const walkJsonl = (dir: string): string[] => {
					const files: string[] = [];
					try { if (!existsSync(dir)) return files; const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const full = join(d, e.name); if (e.isDirectory()) walk(full); else if (e.name.endsWith(".jsonl") && e.name.slice(0, 10) >= cutoffStr) files.push(full); } }; walk(dir); } catch {}
					return files;
				};
				const extractCost = (fp: string): number => {
					let cost = 0;
					try { for (const line of readFileSync(fp, "utf-8").split("\n")) { if (!line.includes('"cost"')) continue; try { const e = JSON.parse(line); if (e?.message?.usage?.cost?.total) cost += e.message.usage.cost.total; } catch {} } } catch {}
					return cost;
				};
				for (const f of walkJsonl(sessionsDir)) { const c = extractCost(f); if (c > 0) { mainCost += c; mainSessions++; } }
				const subDirs: string[] = [];
				try { for (const e of readdirSync(tmpDir, { withFileTypes: true })) { if (e.isDirectory() && e.name.startsWith("pi-subagent-session-")) subDirs.push(join(tmpDir, e.name)); } } catch {}
				for (const d of subDirs) { for (const f of walkJsonl(d)) { const c = extractCost(f); if (c > 0) { subCost += c; subSessions++; } } }
				sendCommandResult("cost", { message: [
					`**Cost Summary** (last ${days} days)`, ``,
					`💰 Total: $${(mainCost + subCost).toFixed(2)}  (${mainSessions + subSessions} sessions)`,
					`   Main: $${mainCost.toFixed(2)} (${mainSessions})  ·  Subagents: $${subCost.toFixed(2)} (${subSessions})`,
				].join("\n") });
				break;
			}

			case "changelog": {
				try {
					const candidates = [
						join(__dirname, "node_modules", "@mariozechner", "pi-coding-agent", "CHANGELOG.md"),
						join(process.env.HOME || process.env.USERPROFILE || "", "AppData", "Roaming", "npm", "node_modules", "@mariozechner", "pi-coding-agent", "CHANGELOG.md"),
						join("/usr", "local", "lib", "node_modules", "@mariozechner", "pi-coding-agent", "CHANGELOG.md"),
					];
					const clPath = candidates.find(p => existsSync(p));
					if (clPath) {
						// Parse entries the same way pi does: split on ## headers, reverse (newest first)
						const content = readFileSync(clPath, "utf-8");
						const lines = content.split("\n");
						const entries: { content: string }[] = [];
						let currentLines: string[] = [];
						let inEntry = false;
						for (const line of lines) {
							if (line.startsWith("## ")) {
								if (inEntry && currentLines.length > 0) {
									entries.push({ content: currentLines.join("\n").trim() });
								}
								currentLines = [line];
								inEntry = true;
							} else if (inEntry) {
								currentLines.push(line);
							}
						}
						if (inEntry && currentLines.length > 0) entries.push({ content: currentLines.join("\n").trim() });
						if (entries.length > 0) {
							const md = "**What's New**\n\n" + entries.reverse().map(e => e.content).join("\n\n");
							sendCommandResult("changelog", { message: md });
						} else {
							sendCommandResult("changelog", { success: false, message: "No changelog entries found." });
						}
					} else {
						sendCommandResult("changelog", { success: false, message: "CHANGELOG.md not found." });
					}
				} catch { sendCommandResult("changelog", { success: false, message: "Could not read changelog." }); }
				break;
			}

			case "tree": {
				// Show session tree structure in desktop
				try {
					const roots = (ctx.sessionManager as any).getTree?.() as Array<{ entry: any; children: any[]; label?: string }> | undefined;
					const leafId = ctx.sessionManager.getLeafId();
					if (!roots || roots.length === 0) {
						sendCommandResult("tree", { message: "Session tree is empty." });
						break;
					}
					const lines: string[] = ["**Session Tree**", ""];
					const renderNode = (node: any, prefix: string, isLast: boolean) => {
						const e = node.entry;
						const isLeaf = e.id === leafId;
						let desc = "";
						if (e.type === "message") {
							const role = e.message?.role || "?";
							let text = "";
							if (Array.isArray(e.message?.content)) {
								for (const b of e.message.content) { if (b.type === "text") text += b.text; }
							} else if (typeof e.message?.content === "string") { text = e.message.content; }
							text = text.slice(0, 60).replace(/\n/g, " ").trim();
							desc = `${role}: ${text || "..."}` ;
						} else if (e.type === "compaction") {
							desc = "[compaction]";
						} else {
							desc = `[${e.type}]`;
						}
						if (node.label) desc += ` 🏷️ ${node.label}`;
						const marker = isLeaf ? "◉ " : "○ ";
						const connector = prefix ? (isLast ? "└─ " : "├─ ") : "";
						lines.push(`${prefix}${connector}${marker}${desc}`);
						const childPrefix = prefix + (prefix ? (isLast ? "   " : "│  ") : "");
						for (let i = 0; i < node.children.length; i++) {
							renderNode(node.children[i], childPrefix, i === node.children.length - 1);
						}
					};
					for (let i = 0; i < roots.length; i++) {
						renderNode(roots[i], "", i === roots.length - 1);
					}
					sendCommandResult("tree", { message: lines.join("\n") });
				} catch { sendCommandResult("tree", { success: false, message: "Could not build session tree." }); }
				break;
			}
		}
	}

	// ─── Keyboard Shortcut ────────────────────────────────────

	pi.registerShortcut(Key.ctrlAlt("n"), {
		description: "Open pi Desktop window",
		handler: async (ctx) => {
			openDesktopWindow(ctx);
		},
	});

	let pendingTerminalCmd: string | null = null;

	/** Inject a slash command into the terminal by routing through sendUserMessage → input event.
	 *  The input event intercepts the text, sets it in the terminal editor, and simulates Enter.
	 *  The terminal then processes it through its normal pipeline with expandPromptTemplates: true. */
	function injectIntoTerminal(cmd: string): void {
		const lcCmd = cmd.replace(/^\//,"").split(/\s/)[0];
		if (lcCmd === "new" || lcCmd === "reload" || lcCmd === "resume" || lcCmd === "fork") {
			sessionTransitioning = true;
		}
		pendingTerminalCmd = cmd;
		pendingDesktopUserMessage = true;
		try {
			pi.sendUserMessage(cmd);
		} catch (err) {
			// sendUserMessage may fail if agent is busy. Fall back to direct injection.
			pendingTerminalCmd = null;
			if (lastCtx?.hasUI) {
				lastCtx.ui.setEditorText(cmd);
				setImmediate(() => {
					setTimeout(() => {
						try { process.stdin.emit("data", "\r"); } catch {}
					}, 100);
				});
			}
		}
	}

	// Intercept sendUserMessage calls for terminal-bound slash commands.
	pi.on("input", (event, ctx) => {
		if (pendingTerminalCmd && event.text === pendingTerminalCmd) {
			const cmd = pendingTerminalCmd;
			pendingTerminalCmd = null;
			if (ctx.hasUI) {
				ctx.ui.setEditorText(cmd);
				// Use setImmediate to ensure the prompt() call fully returns
				// before we inject the Enter keystroke into stdin.
				setImmediate(() => {
					setTimeout(() => {
						try {
							// Emit carriage return on stdin to trigger the TUI's input handler
							process.stdin.emit("data", "\r");
						} catch {}
					}, 100);
				});
			}
			return { action: "handled" as const };
		}
	});

	// ─── Session Lifecycle ────────────────────────────────────

	// Unified session lifecycle — v0.65.0 removed session_switch and session_fork.
	// Use session_start with event.reason ("startup" | "reload" | "new" | "resume" | "fork").
	pi.on("session_start", async (event, ctx) => {
		if (!ctx.hasUI) return;

		const reason = (event as any).reason || "startup";
		const previousSessionFile = (event as any).previousSessionFile || null;
		sessionReason = reason;
		sessionTransitioning = false; // Session started successfully — clear transition flag
		lastCommandCtx = null; // Reset stale command context on session change

		projectName = getProjectName(ctx.cwd);
		lastCtx = ctx;
		enableFooter(ctx);
		enableWidget(ctx);
		ctx.ui.setStatus("desktop", ctx.ui.theme.fg("dim", "◈ Desktop"));

		// Notify desktop window of session change with reason context
		if (reason !== "startup" || activeWindow) {
			// Re-attach event handlers whenever we adopt a window from a previous extension instance.
			// This covers reload, new, resume, fork, AND startup-with-surviving-window.
			// Remove ALL old listeners first — the previous instance's handlers captured a
			// now-stale `pi` reference that throws "stale extension ctx" on use.
			if (activeWindow) {
				const adoptedWin = activeWindow;
				adoptedWin.removeAllListeners("message");
				adoptedWin.removeAllListeners("closed");
				adoptedWin.removeAllListeners("error");
				adoptedWin.on("message", handleWindowMessage);
				adoptedWin.on("closed", () => { if (activeWindow === adoptedWin) setActiveWindow(null); });
				adoptedWin.on("error", () => { if (activeWindow === adoptedWin) setActiveWindow(null); });
				try { ctx.ui.setHiddenThinkingLabel?.("thinking (visible in Desktop ◈)"); } catch {}
			}
			const messages = extractSessionMessages(ctx);
			const stats = getTokenStats(ctx);
			const sessionFile = (ctx.sessionManager as any).getSessionFile?.() ?? null;
			const sessionDir = sessionFile ? join(sessionFile, "..") : null;
			const threads = getSessionThreads(sessionDir).map(t => ({
				name: t.name, file: t.file, date: t.date.toISOString(),
			}));
			sendToWindow({
				type: "session-changed",
				reason,
				previousSessionFile,
				projectName,
				model: ctx.model?.id || "no-model",
				messages,
				stats,
				threads,
			});
		}

		// Auto-open desktop window if --desktop flag or PI_DESKTOP env is set
		if (reason === "startup") {
			const desktopFlag = pi.getFlag("desktop");
			const desktopEnv = process.env.PI_DESKTOP === "1";
			if (desktopFlag || desktopEnv) {
				setTimeout(() => openDesktopWindow(ctx), 500);
			}
		}
	});

	pi.on("session_shutdown", async () => {
		// Don't close the window during session transitions (new/reload/resume/fork)
		// — the window should survive and receive the new session's data.
		if (!sessionTransitioning) {
			closeActiveWindow();
		}
	});
}
