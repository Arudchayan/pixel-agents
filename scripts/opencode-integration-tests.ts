import assert from 'node:assert/strict'
import { processOpenCodeExport } from '../src/transcriptParser.js'
import { AgentRuntime } from '../src/types.js'
import type { AgentState } from '../src/types.js'

type Msg = { type?: string; status?: string; toolId?: string; id?: number }

function createAgent(): AgentState {
  return {
    id: 1,
    terminalRef: {} as never,
    runtime: AgentRuntime.OPENCODE,
    projectDir: process.cwd(),
    jsonlFile: '',
    opencodeSessionId: 'ses_test',
    opencodeSeenMessageIds: new Set<string>(),
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set<string>(),
    activeToolStatuses: new Map<string, string>(),
    activeToolNames: new Map<string, string>(),
    activeSubagentToolIds: new Map<string, Set<string>>(),
    activeSubagentToolNames: new Map<string, Map<string, string>>(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
  }
}

function createHarness() {
  const agent = createAgent()
  const agents = new Map<number, AgentState>([[1, agent]])
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>()
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>()
  const messages: Msg[] = []
  const webview = {
    postMessage(msg: Msg) {
      messages.push(msg)
    },
  }

  return {
    agent,
    agents,
    waitingTimers,
    permissionTimers,
    messages,
    webview,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}`)
    throw error
  }
}

async function caseNonExemptToolFlow(): Promise<void> {
  const h = createHarness()
  const exported = {
    messages: [
      {
        info: {
          id: 'm1',
          role: 'assistant',
        },
        parts: [
          {
            type: 'tool',
            id: 'p1',
            callID: 'call-read-1',
            tool: 'read',
            state: {
              input: { file_path: '/tmp/notes.txt' },
            },
          },
        ],
      },
    ],
  }

  processOpenCodeExport(1, exported, h.agents, h.waitingTimers, h.permissionTimers, h.webview as never)
  await sleep(350)

  assert.equal(h.permissionTimers.has(1), true)
  assert.equal(h.messages.some((m) => m.type === 'agentStatus' && m.status === 'active'), true)
  assert.equal(h.messages.some((m) => m.type === 'agentToolStart' && m.status?.startsWith('Reading ')), true)
  assert.equal(h.messages.some((m) => m.type === 'agentToolDone' && m.toolId === 'call-read-1'), true)
}

async function caseExemptToolNoPermissionTimer(): Promise<void> {
  const h = createHarness()
  const exported = {
    messages: [
      {
        info: {
          id: 'm2',
          role: 'assistant',
        },
        parts: [
          {
            type: 'tool',
            id: 'p2',
            callID: 'call-question-1',
            tool: 'question',
            state: { input: {} },
          },
        ],
      },
    ],
  }

  processOpenCodeExport(1, exported, h.agents, h.waitingTimers, h.permissionTimers, h.webview as never)
  await sleep(350)

  assert.equal(h.permissionTimers.has(1), false)
  assert.equal(h.messages.some((m) => m.type === 'agentToolStart'), true)
  assert.equal(h.messages.some((m) => m.type === 'agentToolDone'), true)
}

async function caseUserMessageClearsActivity(): Promise<void> {
  const h = createHarness()
  h.agent.activeToolIds.add('old-tool')
  h.agent.activeToolStatuses.set('old-tool', 'Reading old.txt')
  h.agent.activeToolNames.set('old-tool', 'Read')

  const exported = {
    messages: [
      {
        info: {
          id: 'm3',
          role: 'user',
        },
        parts: [],
      },
    ],
  }

  processOpenCodeExport(1, exported, h.agents, h.waitingTimers, h.permissionTimers, h.webview as never)

  assert.equal(h.agent.activeToolIds.size, 0)
  assert.equal(h.messages.some((m) => m.type === 'agentToolsClear'), true)
  assert.equal(h.messages.some((m) => m.type === 'agentStatus' && m.status === 'active'), true)
}

async function caseDuplicateMessageIdIgnored(): Promise<void> {
  const h = createHarness()
  const exported = {
    messages: [
      {
        info: {
          id: 'm4',
          role: 'assistant',
          time: { completed: Date.now() },
        },
        parts: [
          {
            type: 'tool',
            id: 'p4',
            callID: 'call-grep-1',
            tool: 'grep',
            state: { input: {} },
          },
        ],
      },
    ],
  }

  processOpenCodeExport(1, exported, h.agents, h.waitingTimers, h.permissionTimers, h.webview as never)
  await sleep(350)
  const firstCount = h.messages.length

  processOpenCodeExport(1, exported, h.agents, h.waitingTimers, h.permissionTimers, h.webview as never)
  await sleep(50)

  assert.equal(h.messages.length, firstCount)
}

async function caseUnknownToolFallbackStatus(): Promise<void> {
  const h = createHarness()
  const exported = {
    messages: [
      {
        info: {
          id: 'm5',
          role: 'assistant',
        },
        parts: [
          {
            type: 'tool',
            id: 'p5',
            callID: 'call-custom-1',
            tool: 'custom_tool_xyz',
            state: { input: {} },
          },
        ],
      },
    ],
  }

  processOpenCodeExport(1, exported, h.agents, h.waitingTimers, h.permissionTimers, h.webview as never)
  await sleep(350)

  assert.equal(h.messages.some((m) => m.type === 'agentToolStart' && m.status === 'Using custom_tool_xyz'), true)
}

async function caseCompletedTurnSetsWaiting(): Promise<void> {
  const h = createHarness()
  const exported = {
    messages: [
      {
        info: {
          id: 'm6',
          role: 'assistant',
          time: { completed: Date.now() },
        },
        parts: [],
      },
    ],
  }

  processOpenCodeExport(1, exported, h.agents, h.waitingTimers, h.permissionTimers, h.webview as never)
  assert.equal(h.agent.isWaiting, true)
  assert.equal(h.messages.some((m) => m.type === 'agentStatus' && m.status === 'waiting'), true)
}

async function caseTaskEmitsSubagentLifecycle(): Promise<void> {
  const h = createHarness()
  const exported = {
    messages: [
      {
        info: {
          id: 'm7',
          role: 'assistant',
        },
        parts: [
          {
            type: 'tool',
            id: 'p7',
            callID: 'call-task-1',
            tool: 'task',
            state: {
              input: { description: 'Investigate parser flow' },
            },
          },
        ],
      },
    ],
  }

  processOpenCodeExport(1, exported, h.agents, h.waitingTimers, h.permissionTimers, h.webview as never)
  await sleep(350)

  assert.equal(h.messages.some((m) => m.type === 'agentToolStart' && m.toolId === 'call-task-1' && m.status?.startsWith('Subtask:')), true)
  assert.equal(h.messages.some((m) => m.type === 'subagentToolStart' && m.id === 1), true)
  assert.equal(h.messages.some((m) => m.type === 'subagentToolDone' && m.id === 1), true)
  assert.equal(h.messages.some((m) => m.type === 'subagentClear' && m.id === 1), true)
}

async function main(): Promise<void> {
  await runCase('OC-A1 non-exempt tool flow', caseNonExemptToolFlow)
  await runCase('OC-A2 exempt tool no permission timer', caseExemptToolNoPermissionTimer)
  await runCase('OC-A3 user message clears activity', caseUserMessageClearsActivity)
  await runCase('OC-A4 duplicate message id ignored', caseDuplicateMessageIdIgnored)
  await runCase('OC-A5 unknown tool fallback', caseUnknownToolFallbackStatus)
  await runCase('OC-A6 completed turn sets waiting', caseCompletedTurnSetsWaiting)
  await runCase('OC-A7 task emits subagent lifecycle', caseTaskEmitsSubagentLifecycle)
  console.log('All OpenCode integration parser tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
