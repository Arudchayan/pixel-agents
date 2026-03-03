import * as path from 'path';
import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import {
	cancelWaitingTimer,
	startWaitingTimer,
	clearAgentActivity,
	startPermissionTimer,
	cancelPermissionTimer,
} from './timerManager.js';
import {
	TOOL_DONE_DELAY_MS,
	TEXT_IDLE_DELAY_MS,
	BASH_COMMAND_DISPLAY_MAX_LENGTH,
	TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from './constants.js';

export const PERMISSION_EXEMPT_TOOLS = new Set(['Task', 'AskUserQuestion']);

function normalizeOpenCodeToolName(tool: string): string {
	const key = tool.toLowerCase();
	switch (key) {
		case 'read': return 'Read';
		case 'edit': return 'Edit';
		case 'write': return 'Write';
		case 'bash': return 'Bash';
		case 'glob': return 'Glob';
		case 'grep': return 'Grep';
		case 'webfetch': return 'WebFetch';
		case 'websearch': return 'WebSearch';
		case 'task': return 'Task';
		case 'question': return 'AskUserQuestion';
		default: return tool;
	}
}

export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
	const base = (p: unknown) => typeof p === 'string' ? path.basename(p) : '';
	switch (toolName) {
		case 'Read': return `Reading ${base(input.file_path)}`;
		case 'Edit': return `Editing ${base(input.file_path)}`;
		case 'Write': return `Writing ${base(input.file_path)}`;
		case 'Bash': {
			const cmd = (input.command as string) || '';
			return `Running: ${cmd.length > BASH_COMMAND_DISPLAY_MAX_LENGTH ? cmd.slice(0, BASH_COMMAND_DISPLAY_MAX_LENGTH) + '\u2026' : cmd}`;
		}
		case 'Glob': return 'Searching files';
		case 'Grep': return 'Searching code';
		case 'WebFetch': return 'Fetching web content';
		case 'WebSearch': return 'Searching the web';
		case 'Task': {
			const desc = typeof input.description === 'string' ? input.description : '';
			return desc ? `Subtask: ${desc.length > TASK_DESCRIPTION_DISPLAY_MAX_LENGTH ? desc.slice(0, TASK_DESCRIPTION_DISPLAY_MAX_LENGTH) + '\u2026' : desc}` : 'Subtask: Running subtask';
		}
		case 'AskUserQuestion': return 'Waiting for your answer';
		case 'EnterPlanMode': return 'Planning';
		case 'NotebookEdit': return `Editing notebook`;
		default: return `Using ${toolName}`;
	}
}

export function processTranscriptLine(
	agentId: number,
	line: string,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	try {
		const record = JSON.parse(line);

		if (record.type === 'assistant' && Array.isArray(record.message?.content)) {
			const blocks = record.message.content as Array<{
				type: string; id?: string; name?: string; input?: Record<string, unknown>;
			}>;
			const hasToolUse = blocks.some(b => b.type === 'tool_use');

			if (hasToolUse) {
				cancelWaitingTimer(agentId, waitingTimers);
				agent.isWaiting = false;
				agent.hadToolsInTurn = true;
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				let hasNonExemptTool = false;
				for (const block of blocks) {
					if (block.type === 'tool_use' && block.id) {
						const toolName = block.name || '';
						const status = formatToolStatus(toolName, block.input || {});
						console.log(`[Pixel Agents] Agent ${agentId} tool start: ${block.id} ${status}`);
						agent.activeToolIds.add(block.id);
						agent.activeToolStatuses.set(block.id, status);
						agent.activeToolNames.set(block.id, toolName);
						if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
							hasNonExemptTool = true;
						}
						webview?.postMessage({
							type: 'agentToolStart',
							id: agentId,
							toolId: block.id,
							status,
						});
					}
				}
				if (hasNonExemptTool) {
					startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
				}
			} else if (blocks.some(b => b.type === 'text') && !agent.hadToolsInTurn) {
				// Text-only response in a turn that hasn't used any tools.
				// turn_duration handles tool-using turns reliably but is never
				// emitted for text-only turns, so we use a silence-based timer:
				// if no new JSONL data arrives within TEXT_IDLE_DELAY_MS, mark as waiting.
				startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers, webview);
			}
		} else if (record.type === 'progress') {
			processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers, webview);
		} else if (record.type === 'user') {
			const content = record.message?.content;
			if (Array.isArray(content)) {
				const blocks = content as Array<{ type: string; tool_use_id?: string }>;
				const hasToolResult = blocks.some(b => b.type === 'tool_result');
				if (hasToolResult) {
					for (const block of blocks) {
						if (block.type === 'tool_result' && block.tool_use_id) {
							console.log(`[Pixel Agents] Agent ${agentId} tool done: ${block.tool_use_id}`);
							const completedToolId = block.tool_use_id;
							// If the completed tool was a Task, clear its subagent tools
							if (agent.activeToolNames.get(completedToolId) === 'Task') {
								agent.activeSubagentToolIds.delete(completedToolId);
								agent.activeSubagentToolNames.delete(completedToolId);
								webview?.postMessage({
									type: 'subagentClear',
									id: agentId,
									parentToolId: completedToolId,
								});
							}
							agent.activeToolIds.delete(completedToolId);
							agent.activeToolStatuses.delete(completedToolId);
							agent.activeToolNames.delete(completedToolId);
							const toolId = completedToolId;
							setTimeout(() => {
								webview?.postMessage({
									type: 'agentToolDone',
									id: agentId,
									toolId,
								});
							}, TOOL_DONE_DELAY_MS);
						}
					}
					// All tools completed — allow text-idle timer as fallback
					// for turn-end detection when turn_duration is not emitted
					if (agent.activeToolIds.size === 0) {
						agent.hadToolsInTurn = false;
					}
				} else {
					// New user text prompt — new turn starting
					cancelWaitingTimer(agentId, waitingTimers);
					clearAgentActivity(agent, agentId, permissionTimers, webview);
					agent.hadToolsInTurn = false;
				}
			} else if (typeof content === 'string' && content.trim()) {
				// New user text prompt — new turn starting
				cancelWaitingTimer(agentId, waitingTimers);
				clearAgentActivity(agent, agentId, permissionTimers, webview);
				agent.hadToolsInTurn = false;
			}
		} else if (record.type === 'system' && record.subtype === 'turn_duration') {
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);

			// Definitive turn-end: clean up any stale tool state
			if (agent.activeToolIds.size > 0) {
				agent.activeToolIds.clear();
				agent.activeToolStatuses.clear();
				agent.activeToolNames.clear();
				agent.activeSubagentToolIds.clear();
				agent.activeSubagentToolNames.clear();
				webview?.postMessage({ type: 'agentToolsClear', id: agentId });
			}

			agent.isWaiting = true;
			agent.permissionSent = false;
			agent.hadToolsInTurn = false;
			webview?.postMessage({
				type: 'agentStatus',
				id: agentId,
				status: 'waiting',
			});
		}
	} catch {
		// Ignore malformed lines
	}
}

export function processOpenCodeExport(
	agentId: number,
	exported: Record<string, unknown>,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;
	const messages = exported.messages;
	if (!Array.isArray(messages)) return;
	const safeStringify = (value: unknown): string => {
		try {
			return JSON.stringify(value) ?? '';
		} catch {
			return '';
		}
	};
	const computeFingerprint = (
		messageId: string,
		role: string,
		completed: boolean,
		parts: Array<Record<string, unknown>>,
	): string => {
		const partSummary = parts.map((part) => {
			const type = typeof part.type === 'string' ? part.type : '';
			if (type !== 'tool') {
				return type;
			}
			const callID = typeof part.callID === 'string' ? part.callID : '';
			const id = typeof part.id === 'string' ? part.id : '';
			const tool = typeof part.tool === 'string' ? part.tool : '';
			const stateRaw = safeStringify(part.state);
			return `${type}:${tool}:${callID || id}:${stateRaw}`;
		}).join('|');
		return `${messageId}:${role}:${completed ? '1' : '0'}:${partSummary}`;
	};

	for (const message of messages as Array<Record<string, unknown>>) {
		const info = message.info as Record<string, unknown> | undefined;
		const messageId = typeof info?.id === 'string' ? info.id : '';
		if (!messageId) {
			continue;
		}

		const role = typeof info?.role === 'string' ? info.role : '';
		const timeInfo = info?.time;
		const completed = typeof (timeInfo as Record<string, unknown> | undefined)?.completed === 'number';
		const rawParts = message.parts;
		const parts = Array.isArray(rawParts) ? rawParts as Array<Record<string, unknown>> : [];
		const fingerprint = computeFingerprint(messageId, role, completed, parts);
		if (agent.opencodeMessageStateHashes.get(messageId) === fingerprint) {
			continue;
		}
		agent.opencodeMessageStateHashes.set(messageId, fingerprint);
		while (agent.opencodeMessageStateHashes.size > 2000) {
			const firstKey = agent.opencodeMessageStateHashes.keys().next().value as string | undefined;
			if (!firstKey) break;
			agent.opencodeMessageStateHashes.delete(firstKey);
		}

		if (role === 'user') {
			cancelWaitingTimer(agentId, waitingTimers);
			clearAgentActivity(agent, agentId, permissionTimers, webview);
			continue;
		}
		if (role !== 'assistant') {
			continue;
		}

		let hasNonExempt = false;
		for (const part of parts) {
			if (part.type !== 'tool') {
				continue;
			}
			const state = part.state as Record<string, unknown> | undefined;
			const rawTool = typeof part.tool === 'string' ? part.tool : '';
			if (!state || !rawTool) {
				continue;
			}
			const toolName = normalizeOpenCodeToolName(rawTool);
			const input = (state.input && typeof state.input === 'object') ? state.input as Record<string, unknown> : {};
			const toolId = (typeof part.callID === 'string' && part.callID)
				|| (typeof part.id === 'string' && part.id)
				|| `${messageId}:${toolName}`;
			const status = formatToolStatus(toolName, input);
			const isTaskTool = toolName === 'Task';
			const subagentToolId = `${toolId}:subtask`;
			const wasActive = agent.activeToolIds.has(toolId);
			if (!wasActive) {
				agent.activeToolIds.add(toolId);
				agent.activeToolStatuses.set(toolId, status);
				agent.activeToolNames.set(toolId, toolName);
				cancelWaitingTimer(agentId, waitingTimers);
				agent.isWaiting = false;
				agent.hadToolsInTurn = true;
				webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'active' });
				webview?.postMessage({ type: 'agentToolStart', id: agentId, toolId, status });
				if (isTaskTool) {
					let subTools = agent.activeSubagentToolIds.get(toolId);
					if (!subTools) {
						subTools = new Set();
						agent.activeSubagentToolIds.set(toolId, subTools);
					}
					subTools.add(subagentToolId);
					let subNames = agent.activeSubagentToolNames.get(toolId);
					if (!subNames) {
						subNames = new Map();
						agent.activeSubagentToolNames.set(toolId, subNames);
					}
					subNames.set(subagentToolId, toolName);
					webview?.postMessage({
						type: 'subagentToolStart',
						id: agentId,
						parentToolId: toolId,
						toolId: subagentToolId,
						status: 'Running subtask',
					});
				}
			} else {
				agent.activeToolStatuses.set(toolId, status);
			}

			if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
				hasNonExempt = true;
			}

			if (completed && agent.activeToolIds.has(toolId)) {
				agent.activeToolIds.delete(toolId);
				agent.activeToolStatuses.delete(toolId);
				agent.activeToolNames.delete(toolId);
				setTimeout(() => {
					webview?.postMessage({ type: 'agentToolDone', id: agentId, toolId });
					if (isTaskTool) {
						webview?.postMessage({
							type: 'subagentToolDone',
							id: agentId,
							parentToolId: toolId,
							toolId: subagentToolId,
						});
						webview?.postMessage({
							type: 'subagentClear',
							id: agentId,
							parentToolId: toolId,
						});
					}
				}, TOOL_DONE_DELAY_MS);
				if (isTaskTool) {
					agent.activeSubagentToolIds.delete(toolId);
					agent.activeSubagentToolNames.delete(toolId);
				}
			}
		}

		if (!completed && hasNonExempt) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}

		if (completed) {
			cancelWaitingTimer(agentId, waitingTimers);
			cancelPermissionTimer(agentId, permissionTimers);
			agent.isWaiting = true;
			agent.permissionSent = false;
			agent.hadToolsInTurn = false;
			webview?.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
		}
	}
}

function processProgressRecord(
	agentId: number,
	record: Record<string, unknown>,
	agents: Map<number, AgentState>,
	waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
	permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
	webview: vscode.Webview | undefined,
): void {
	const agent = agents.get(agentId);
	if (!agent) return;

	const parentToolId = record.parentToolUseID as string | undefined;
	if (!parentToolId) return;

	const data = record.data as Record<string, unknown> | undefined;
	if (!data) return;

	// bash_progress / mcp_progress: tool is actively executing, not stuck on permission.
	// Restart the permission timer to give the running tool another window.
	const dataType = data.type as string | undefined;
	if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
		if (agent.activeToolIds.has(parentToolId)) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
		return;
	}

	// Verify parent is an active Task tool (agent_progress handling)
	if (agent.activeToolNames.get(parentToolId) !== 'Task') return;

	const msg = data.message as Record<string, unknown> | undefined;
	if (!msg) return;

	const msgType = msg.type as string;
	const innerMsg = msg.message as Record<string, unknown> | undefined;
	const content = innerMsg?.content;
	if (!Array.isArray(content)) return;

	if (msgType === 'assistant') {
		let hasNonExemptSubTool = false;
		for (const block of content) {
			if (block.type === 'tool_use' && block.id) {
				const toolName = block.name || '';
				const status = formatToolStatus(toolName, block.input || {});
				console.log(`[Pixel Agents] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`);

				// Track sub-tool IDs
				let subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (!subTools) {
					subTools = new Set();
					agent.activeSubagentToolIds.set(parentToolId, subTools);
				}
				subTools.add(block.id);

				// Track sub-tool names (for permission checking)
				let subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (!subNames) {
					subNames = new Map();
					agent.activeSubagentToolNames.set(parentToolId, subNames);
				}
				subNames.set(block.id, toolName);

				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					hasNonExemptSubTool = true;
				}

				webview?.postMessage({
					type: 'subagentToolStart',
					id: agentId,
					parentToolId,
					toolId: block.id,
					status,
				});
			}
		}
		if (hasNonExemptSubTool) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
	} else if (msgType === 'user') {
		for (const block of content) {
			if (block.type === 'tool_result' && block.tool_use_id) {
				console.log(`[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`);

				// Remove from tracking
				const subTools = agent.activeSubagentToolIds.get(parentToolId);
				if (subTools) {
					subTools.delete(block.tool_use_id);
				}
				const subNames = agent.activeSubagentToolNames.get(parentToolId);
				if (subNames) {
					subNames.delete(block.tool_use_id);
				}

				const toolId = block.tool_use_id;
				setTimeout(() => {
					webview?.postMessage({
						type: 'subagentToolDone',
						id: agentId,
						parentToolId,
						toolId,
					});
				}, 300);
			}
		}
		// If there are still active non-exempt sub-agent tools, restart the permission timer
		// (handles the case where one sub-agent completes but another is still stuck)
		let stillHasNonExempt = false;
		for (const [, subNames] of agent.activeSubagentToolNames) {
			for (const [, toolName] of subNames) {
				if (!PERMISSION_EXEMPT_TOOLS.has(toolName)) {
					stillHasNonExempt = true;
					break;
				}
			}
			if (stillHasNonExempt) break;
		}
		if (stillHasNonExempt) {
			startPermissionTimer(agentId, agents, permissionTimers, PERMISSION_EXEMPT_TOOLS, webview);
		}
	}
}
