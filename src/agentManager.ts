import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { AgentRuntime } from './types.js';
import type { AgentState, PersistedAgent } from './types.js';
import { cancelWaitingTimer, cancelPermissionTimer } from './timerManager.js';
import { startFileWatching, readNewLines, ensureProjectScan } from './fileWatcher.js';
import { processOpenCodeExport } from './transcriptParser.js';
import { JSONL_POLL_INTERVAL_MS, OPENCODE_RUNNING_WINDOW_MS, TERMINAL_NAME_PREFIX_CLAUDE, TERMINAL_NAME_PREFIX_OPENCODE, WORKSPACE_KEY_AGENTS, WORKSPACE_KEY_AGENT_SEATS } from './constants.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';

export function getProjectDirPath(cwd?: string): string | null {
	const workspacePath = cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (!workspacePath) return null;
	const dirName = workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
	const projectDir = path.join(os.homedir(), '.claude', 'projects', dirName);
	console.log(`[Pixel Agents] Project dir: ${workspacePath} → ${dirName}`);
	return projectDir;
}

function getOpenCodeDataDir(): string {
	return path.join(os.homedir(), '.local', 'share', 'opencode');
}

interface OpenCodeSessionSummary {
	id: string;
	title?: string;
	updated?: number;
	created?: number;
	directory?: string;
}

interface ClaudeSessionSummary {
	filePath: string;
	projectDir: string;
	updated: number;
}

function getOpenCodeExecutables(): string[] {
	const candidates: string[] = [
		'opencode',
		'opencode.cmd',
		path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'opencode.cmd'),
		path.join(os.homedir(), '.local', 'share', 'opencode', 'bin', 'opencode'),
		path.join(os.homedir(), '.local', 'share', 'opencode', 'bin', 'opencode.exe'),
	];
	return Array.from(new Set(candidates));
}

function runOpenCode(args: string[], cwd: string | undefined, maxBuffer = 2 * 1024 * 1024): string | null {
	for (const exe of getOpenCodeExecutables()) {
		try {
			return cp.execFileSync(exe, args, {
				encoding: 'utf-8',
				cwd,
				windowsHide: true,
				maxBuffer,
			});
		} catch {
			continue;
		}
	}
	return null;
}

function parseJsonFromOutput(raw: string): unknown {
	const cleaned = raw.replace(/\x1b\[[0-9;]*m/g, '');
	const starts: number[] = [];
	for (let i = 0; i < cleaned.length; i++) {
		const ch = cleaned[i];
		if (ch === '{' || ch === '[') {
			starts.push(i);
		}
	}
	for (const start of starts) {
		try {
			return JSON.parse(cleaned.slice(start));
		} catch {
			continue;
		}
	}
	throw new Error('No JSON payload found');
}

function formatAgentLabel(runtime: AgentRuntime, externalSession: boolean, folderName?: string): string {
	const runtimeTag = runtime === AgentRuntime.OPENCODE ? 'OpenCode' : 'Claude';
	if (externalSession) {
		return `${runtimeTag} (external)`;
	}
	if (folderName) {
		return `${runtimeTag}: ${folderName}`;
	}
	return runtimeTag;
}

function listRecentClaudeSessions(): ClaudeSessionSummary[] {
	const root = path.join(os.homedir(), '.claude', 'projects');
	let projectDirs: string[];
	try {
		projectDirs = fs.readdirSync(root, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => path.join(root, d.name));
	} catch {
		return [];
	}

	const sessions: ClaudeSessionSummary[] = [];
	for (const projectDir of projectDirs) {
		let files: string[];
		try {
			files = fs.readdirSync(projectDir)
				.filter((f) => f.endsWith('.jsonl'))
				.map((f) => path.join(projectDir, f));
		} catch {
			continue;
		}

		for (const filePath of files) {
			try {
				const stat = fs.statSync(filePath);
				sessions.push({ filePath, projectDir, updated: stat.mtimeMs });
			} catch {
				continue;
			}
		}
	}

	return sessions;
}

function listOpenCodeSessions(cwd: string | undefined): OpenCodeSessionSummary[] {
	const dbOut = runOpenCode([
		'db',
		'select id, title, directory, time_updated as updated, time_created as created from session where time_archived is null order by time_updated desc limit 100',
		'--format',
		'json',
	], undefined, 4 * 1024 * 1024);
	if (dbOut) {
		try {
			const parsed = parseJsonFromOutput(dbOut);
			if (Array.isArray(parsed)) {
				const sessions: OpenCodeSessionSummary[] = [];
				for (const item of parsed) {
					if (!item || typeof item !== 'object') {
						continue;
					}
					const row = item as Record<string, unknown>;
					const id = typeof row.id === 'string' ? row.id : '';
					if (!id.startsWith('ses_')) {
						continue;
					}
					sessions.push({
						id,
						title: typeof row.title === 'string' ? row.title : undefined,
						updated: typeof row.updated === 'number' ? row.updated : undefined,
						created: typeof row.created === 'number' ? row.created : undefined,
						directory: typeof row.directory === 'string' ? row.directory : undefined,
					});
				}
				if (sessions.length > 0) {
					return sessions;
				}
			}
		} catch {
		}
	}

	const jsonOut = runOpenCode(['session', 'list', '--format', 'json', '-n', '50'], cwd);
	if (jsonOut) {
		try {
			const parsed = parseJsonFromOutput(jsonOut);
			if (Array.isArray(parsed)) {
				const sessions: OpenCodeSessionSummary[] = [];
				for (const item of parsed) {
					if (!item || typeof item !== 'object') {
						continue;
					}
					const row = item as Record<string, unknown>;
					const id = typeof row.id === 'string' ? row.id : '';
					if (!id.startsWith('ses_')) {
						continue;
					}
					let updated: number | undefined;
					if (typeof row.updated === 'number') {
						updated = row.updated;
					} else if (typeof row.updated === 'string') {
						const parsedTs = Date.parse(row.updated);
						if (!Number.isNaN(parsedTs)) {
							updated = parsedTs;
						}
					}
					sessions.push({
						id,
						title: typeof row.title === 'string' ? row.title : undefined,
						updated,
						created: typeof row.created === 'number' ? row.created : undefined,
						directory: typeof row.directory === 'string' ? row.directory : undefined,
					});
				}
				if (sessions.length > 0) {
					return sessions;
				}
			}
		} catch {
		}
	}

	const textOut = runOpenCode(['session', 'list', '-n', '20'], cwd) ?? runOpenCode(['session', 'list'], cwd);
	if (!textOut) {
		return [];
	}
	const ids = new Set<string>();
	for (const match of textOut.matchAll(/ses_[A-Za-z0-9]+/g)) {
		ids.add(match[0]);
	}
	const now = Date.now();
	return Array.from(ids).map((id) => ({ id, updated: now }));
}

function tryGetLatestOpenCodeSessionId(cwd: string | undefined): string | null {
	const sessions = listOpenCodeSessions(cwd)
		.sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
	if (sessions.length > 0) {
		return sessions[0].id;
	}
	return null;
}

function tryExportOpenCodeSession(sessionId: string, cwd: string | undefined): Record<string, unknown> | null {
	const out = runOpenCode(['export', sessionId], cwd, 10 * 1024 * 1024);
	if (!out) {
		return null;
	}
	try {
		const parsed = parseJsonFromOutput(out);
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
	}
	return null;
}

function pollOpenCodeSession(
	agentId: number,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent || agent.runtime !== AgentRuntime.OPENCODE) return;

	if (!agent.opencodeSessionId) {
		agent.opencodeSessionId = tryGetLatestOpenCodeSessionId(agent.projectDir) ?? undefined;
		if (!agent.opencodeSessionId) return;
		const firstExport = tryExportOpenCodeSession(agent.opencodeSessionId, agent.projectDir);
		if (firstExport && Array.isArray(firstExport.messages)) {
			for (const msg of firstExport.messages as Array<Record<string, unknown>>) {
				const info = msg.info as Record<string, unknown> | undefined;
				const messageId = typeof info?.id === 'string' ? info.id : '';
				if (messageId) {
					agent.opencodeSeenMessageIds.add(messageId);
				}
			}
		}
		console.log(`[Pixel Agents] Agent ${agentId}: linked OpenCode session ${agent.opencodeSessionId}`);
	}

	const exported = tryExportOpenCodeSession(agent.opencodeSessionId, agent.projectDir);
	if (!exported) return;

	processOpenCodeExport(agentId, exported, agents, waitingTimers, permissionTimers, webview);
}

export function discoverAndAdoptOpenCodeSessions(
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): { found: number; adopted: number } {
	const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	const sessions = listOpenCodeSessions(undefined);
	if (sessions.length === 0) {
		return { found: 0, adopted: 0 };
	}
	let adopted = 0;

	const knownSessionIds = new Set<string>();
	for (const agent of agents.values()) {
		if (agent.runtime === AgentRuntime.OPENCODE && agent.opencodeSessionId) {
			knownSessionIds.add(agent.opencodeSessionId);
		}
	}

	const now = Date.now();
	const sorted = [...sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
	for (const session of sorted) {
		if (knownSessionIds.has(session.id)) {
			continue;
		}
		if (typeof session.updated === 'number' && now - session.updated > OPENCODE_RUNNING_WINDOW_MS) {
			continue;
		}

		const id = nextAgentIdRef.current++;
		const projectDir = session.directory || workspaceRoot || getOpenCodeDataDir();
		const folderName = formatAgentLabel(
			AgentRuntime.OPENCODE,
			true,
			session.directory ? path.basename(session.directory) : undefined,
		);
		const agent: AgentState = {
			id,
			terminalRef: null,
			runtime: AgentRuntime.OPENCODE,
			projectDir,
			jsonlFile: '',
			opencodeSessionId: session.id,
			opencodeSeenMessageIds: new Set(),
			opencodeMessageStateHashes: new Map(),
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
			folderName,
			externalSession: true,
		};

		const firstExport = tryExportOpenCodeSession(session.id, projectDir);
		if (firstExport && Array.isArray(firstExport.messages)) {
			for (const msg of firstExport.messages as Array<Record<string, unknown>>) {
				const info = msg.info as Record<string, unknown> | undefined;
				const messageId = typeof info?.id === 'string' ? info.id : '';
				if (messageId) {
					agent.opencodeSeenMessageIds.add(messageId);
				}
			}
		}

		agents.set(id, agent);
		persistAgents();
		webview?.postMessage({ type: 'agentCreated', id, runtime: AgentRuntime.OPENCODE, externalSession: true, folderName });
		const pollTimer = setInterval(() => {
			if (!agents.has(id)) {
				clearInterval(pollTimer);
				jsonlPollTimers.delete(id);
				return;
			}
			pollOpenCodeSession(id, agents, waitingTimers, permissionTimers, webview);
		}, JSONL_POLL_INTERVAL_MS);
		jsonlPollTimers.set(id, pollTimer);
		adopted++;
	}
	return { found: sessions.length, adopted };
}

export function discoverAndAdoptClaudeSessions(
	nextAgentIdRef: { current: number },
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
): { found: number; adopted: number } {
	const sessions = listRecentClaudeSessions();
	if (sessions.length === 0) {
		return { found: 0, adopted: 0 };
	}
	let adopted = 0;

	const knownFiles = new Set<string>();
	for (const agent of agents.values()) {
		if (agent.runtime === AgentRuntime.CLAUDE) {
			knownFiles.add(agent.jsonlFile);
		}
	}

	const now = Date.now();
	const sorted = [...sessions].sort((a, b) => b.updated - a.updated);
	for (const session of sorted) {
		if (knownFiles.has(session.filePath)) {
			continue;
		}
		if (now - session.updated > OPENCODE_RUNNING_WINDOW_MS) {
			continue;
		}

		const id = nextAgentIdRef.current++;
		const folderName = formatAgentLabel(AgentRuntime.CLAUDE, true);
		const agent: AgentState = {
			id,
			terminalRef: null,
			runtime: AgentRuntime.CLAUDE,
			projectDir: session.projectDir,
			jsonlFile: session.filePath,
			opencodeSessionId: undefined,
			opencodeSeenMessageIds: new Set(),
			opencodeMessageStateHashes: new Map(),
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
			folderName,
			externalSession: true,
		};

		try {
			const stat = fs.statSync(session.filePath);
			agent.fileOffset = stat.size;
		} catch {
			agent.fileOffset = 0;
		}

		agents.set(id, agent);
		persistAgents();
		webview?.postMessage({ type: 'agentCreated', id, runtime: AgentRuntime.CLAUDE, externalSession: true, folderName });
		startFileWatching(id, session.filePath, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
		readNewLines(id, agents, waitingTimers, permissionTimers, webview);
		adopted++;
	}
	return { found: sessions.length, adopted };
}

export async function launchNewTerminal(
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	activeAgentIdRef: { current: number | null },
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	webview: vscode.Webview | undefined,
	persistAgents: () => void,
	runtime: AgentRuntime,
	folderPath?: string,
): Promise<void> {
	const folders = vscode.workspace.workspaceFolders;
	const cwd = folderPath || folders?.[0]?.uri.fsPath;
	const isMultiRoot = !!(folders && folders.length > 1);
	const idx = nextTerminalIndexRef.current++;
	const terminalPrefix = runtime === AgentRuntime.OPENCODE ? TERMINAL_NAME_PREFIX_OPENCODE : TERMINAL_NAME_PREFIX_CLAUDE;
	const terminal = vscode.window.createTerminal({
		name: `${terminalPrefix} #${idx}`,
		cwd,
	});
	terminal.show();

	const sessionId = runtime === AgentRuntime.CLAUDE ? crypto.randomUUID() : null;
	if (runtime === AgentRuntime.CLAUDE && sessionId) {
		terminal.sendText(`claude --session-id ${sessionId}`);
	} else {
		terminal.sendText('opencode');
	}

	const projectDir = runtime === AgentRuntime.CLAUDE ? getProjectDirPath(cwd) : (cwd || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || getOpenCodeDataDir());
	if (!projectDir) {
		console.log(`[Pixel Agents] No project dir, cannot track agent`);
		return;
	}

	const expectedFile = runtime === AgentRuntime.CLAUDE && sessionId
		? path.join(projectDir, `${sessionId}.jsonl`)
		: '';
	if (expectedFile) {
		knownJsonlFiles.add(expectedFile);
	}

	// Create agent immediately (before JSONL file exists)
	const id = nextAgentIdRef.current++;
	const rawFolderName = isMultiRoot && cwd ? path.basename(cwd) : undefined;
	const folderName = formatAgentLabel(runtime, false, rawFolderName);
	const agent: AgentState = {
		id,
		terminalRef: terminal,
		runtime,
		projectDir,
		jsonlFile: expectedFile,
		opencodeSessionId: undefined,
		opencodeSeenMessageIds: new Set(),
		opencodeMessageStateHashes: new Map(),
		fileOffset: 0,
		lineBuffer: '',
		activeToolIds: new Set(),
		activeToolStatuses: new Map(),
		activeToolNames: new Map(),
		activeSubagentToolIds: new Map(),
		activeSubagentToolNames: new Map(),
		isWaiting: false,
		permissionSent: false,
		hadToolsInTurn: false,
		folderName,
	};

	agents.set(id, agent);
	activeAgentIdRef.current = id;
	persistAgents();
	console.log(`[Pixel Agents] Agent ${id}: created for terminal ${terminal.name}`);
	webview?.postMessage({ type: 'agentCreated', id, runtime, externalSession: false, folderName });

	if (runtime === AgentRuntime.CLAUDE) {
		ensureProjectScan(
			projectDir, knownJsonlFiles, projectScanTimerRef, activeAgentIdRef,
			nextAgentIdRef, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			webview, persistAgents,
		);

		// Poll for the specific JSONL file to appear
		const pollTimer = setInterval(() => {
			try {
				if (fs.existsSync(agent.jsonlFile)) {
					console.log(`[Pixel Agents] Agent ${id}: found JSONL file ${path.basename(agent.jsonlFile)}`);
					clearInterval(pollTimer);
					jsonlPollTimers.delete(id);
					startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
					readNewLines(id, agents, waitingTimers, permissionTimers, webview);
				}
			} catch { /* file may not exist yet */ }
		}, JSONL_POLL_INTERVAL_MS);
		jsonlPollTimers.set(id, pollTimer);
	} else {
		const pollTimer = setInterval(() => {
			if (!agents.has(id)) {
				clearInterval(pollTimer);
				jsonlPollTimers.delete(id);
				return;
			}
			pollOpenCodeSession(id, agents, waitingTimers, permissionTimers, webview);
		}, JSONL_POLL_INTERVAL_MS);
		jsonlPollTimers.set(id, pollTimer);
	}
}

export function removeAgent(
	agentId: number,
	agents: Map<number, AgentState>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	persistAgents: () => void,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	// Stop JSONL poll timer
	const jpTimer = jsonlPollTimers.get(agentId);
	if (jpTimer) { clearInterval(jpTimer); }
	jsonlPollTimers.delete(agentId);

	// Stop file watching
	fileWatchers.get(agentId)?.close();
	fileWatchers.delete(agentId);
	const pt = pollingTimers.get(agentId);
	if (pt) { clearInterval(pt); }
	pollingTimers.delete(agentId);
	try { fs.unwatchFile(agent.jsonlFile); } catch { /* ignore */ }

	// Cancel timers
	cancelWaitingTimer(agentId, waitingTimers);
	cancelPermissionTimer(agentId, permissionTimers);

	// Remove from maps
	agents.delete(agentId);
	persistAgents();
}

export function persistAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
): void {
	const persisted: PersistedAgent[] = [];
	for (const agent of agents.values()) {
		if (!agent.terminalRef) {
			continue;
		}
		persisted.push({
			id: agent.id,
			terminalName: agent.terminalRef.name,
			runtime: agent.runtime,
			jsonlFile: agent.jsonlFile,
			projectDir: agent.projectDir,
			opencodeSessionId: agent.opencodeSessionId,
			folderName: agent.folderName,
		});
	}
	context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export function restoreAgents(
	context: vscode.ExtensionContext,
	nextAgentIdRef: { current: number },
	nextTerminalIndexRef: { current: number },
	agents: Map<number, AgentState>,
	knownJsonlFiles: Set<string>,
	fileWatchers: Map<number, fs.FSWatcher>,
	pollingTimers: Map<number, ReturnType<typeof setInterval>>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
	projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
	activeAgentIdRef: { current: number | null },
	webview: vscode.Webview | undefined,
	doPersist: () => void,
): void {
	const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
	if (persisted.length === 0) return;

	const liveTerminals = vscode.window.terminals;
	let maxId = 0;
	let maxIdx = 0;
	let restoredProjectDir: string | null = null;

	for (const p of persisted) {
		const terminal = liveTerminals.find(t => t.name === p.terminalName);
		if (!terminal) continue;

		const runtime = p.runtime ?? AgentRuntime.CLAUDE;
		const folderName = p.folderName ?? formatAgentLabel(runtime, false);
		const agent: AgentState = {
			id: p.id,
			terminalRef: terminal,
			runtime,
			projectDir: p.projectDir,
			jsonlFile: p.jsonlFile,
			opencodeSessionId: p.opencodeSessionId,
			opencodeSeenMessageIds: new Set(),
			opencodeMessageStateHashes: new Map(),
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
			folderName,
		};

		agents.set(p.id, agent);
		knownJsonlFiles.add(p.jsonlFile);
		console.log(`[Pixel Agents] Restored agent ${p.id} → terminal "${p.terminalName}"`);

		if (p.id > maxId) maxId = p.id;
		// Extract terminal index from name like "Claude Code #3"
		const match = p.terminalName.match(/#(\d+)$/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIdx) maxIdx = idx;
		}

		restoredProjectDir = p.projectDir;

		if (agent.runtime === AgentRuntime.CLAUDE) {
			// Start file watching if JSONL exists, skipping to end of file
			try {
				if (fs.existsSync(p.jsonlFile)) {
					const stat = fs.statSync(p.jsonlFile);
					agent.fileOffset = stat.size;
					startFileWatching(p.id, p.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
				} else {
					// Poll for the file to appear
					const pollTimer = setInterval(() => {
						try {
							if (fs.existsSync(agent.jsonlFile)) {
								console.log(`[Pixel Agents] Restored agent ${p.id}: found JSONL file`);
								clearInterval(pollTimer);
								jsonlPollTimers.delete(p.id);
								const stat = fs.statSync(agent.jsonlFile);
								agent.fileOffset = stat.size;
								startFileWatching(p.id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, webview);
							}
						} catch { /* file may not exist yet */ }
					}, JSONL_POLL_INTERVAL_MS);
					jsonlPollTimers.set(p.id, pollTimer);
				}
			} catch { /* ignore errors during restore */ }
		} else {
			const pollTimer = setInterval(() => {
				if (!agents.has(p.id)) {
					clearInterval(pollTimer);
					jsonlPollTimers.delete(p.id);
					return;
				}
				pollOpenCodeSession(p.id, agents, waitingTimers, permissionTimers, webview);
			}, JSONL_POLL_INTERVAL_MS);
			jsonlPollTimers.set(p.id, pollTimer);
		}
	}

	// Advance counters past restored IDs
	if (maxId >= nextAgentIdRef.current) {
		nextAgentIdRef.current = maxId + 1;
	}
	if (maxIdx >= nextTerminalIndexRef.current) {
		nextTerminalIndexRef.current = maxIdx + 1;
	}

	// Re-persist cleaned-up list (removes entries whose terminals are gone)
	doPersist();

	if (restoredProjectDir) {
		let hasClaudeAgents = false;
		for (const agent of agents.values()) {
			if (agent.runtime === AgentRuntime.CLAUDE) {
				hasClaudeAgents = true;
				break;
			}
		}
		if (!hasClaudeAgents) {
			return;
		}
		ensureProjectScan(
			restoredProjectDir, knownJsonlFiles, projectScanTimerRef, activeAgentIdRef,
			nextAgentIdRef, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers,
			webview, doPersist,
		);
	}
}

export function sendExistingAgents(
	agents: Map<number, AgentState>,
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	const agentIds: number[] = [];
	for (const id of agents.keys()) {
		agentIds.push(id);
	}
	agentIds.sort((a, b) => a - b);

	// Include persisted palette/seatId from separate key
	const agentMeta = context.workspaceState.get<Record<string, { palette?: number; seatId?: string }>>(WORKSPACE_KEY_AGENT_SEATS, {});

	// Include folderName per agent
	const folderNames: Record<number, string> = {};
	const agentRuntimes: Record<number, AgentRuntime> = {};
	const externalSessions: Record<number, boolean> = {};
	for (const [id, agent] of agents) {
		agentRuntimes[id] = agent.runtime;
		externalSessions[id] = !!agent.externalSession;
		folderNames[id] = agent.folderName || formatAgentLabel(agent.runtime, !!agent.externalSession);
	}
	console.log(`[Pixel Agents] sendExistingAgents: agents=${JSON.stringify(agentIds)}, meta=${JSON.stringify(agentMeta)}`);

	webview.postMessage({
		type: 'existingAgents',
		agents: agentIds,
		agentMeta,
		agentRuntimes,
		externalSessions,
		folderNames,
	});

	sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	if (!webview) return;
	for (const [agentId, agent] of agents) {
		// Re-send active tools
		for (const [toolId, status] of agent.activeToolStatuses) {
			webview.postMessage({
				type: 'agentToolStart',
				id: agentId,
				toolId,
				status,
			});
		}
		// Re-send waiting status
		if (agent.isWaiting) {
			webview.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	}
}

export function sendLayout(
	context: vscode.ExtensionContext,
	webview: vscode.Webview | undefined,
	defaultLayout?: Record<string, unknown> | null,
): void {
	if (!webview) return;
	const layout = migrateAndLoadLayout(context, defaultLayout);
	webview.postMessage({
		type: 'layoutLoaded',
		layout,
	});
}
