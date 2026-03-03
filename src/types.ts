import type * as vscode from 'vscode';

export const AgentRuntime = {
	CLAUDE: 'claude',
	OPENCODE: 'opencode',
} as const;

export type AgentRuntime = typeof AgentRuntime[keyof typeof AgentRuntime];

export interface AgentState {
	id: number;
	terminalRef: vscode.Terminal | null;
	runtime: AgentRuntime;
	projectDir: string;
	jsonlFile: string;
	opencodeSessionId?: string;
	opencodeSeenMessageIds: Set<string>;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
	externalSession?: boolean;
}

export interface PersistedAgent {
	id: number;
	terminalName: string;
	runtime?: AgentRuntime;
	jsonlFile: string;
	projectDir: string;
	opencodeSessionId?: string;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
}
