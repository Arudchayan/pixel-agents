# OpenCode Integration Test Cases

This document defines test cases for the OpenCode runtime integration added to Pixel Agents.

## Scope

- Runtime selection persistence (`claude` vs `opencode`)
- Agent launch flow (`openAgent`)
- OpenCode session polling + export parsing
- Tool/activity event mapping into existing webview messages

## Automated Cases

These are covered by `scripts/opencode-integration-tests.ts`.

### OC-A1: Non-exempt tool maps to active/start/done

- Input: exported OpenCode message containing assistant `tool` part for `read`
- Expected:
  - Emits `agentStatus: active`
  - Emits `agentToolStart` with status `Reading <file>`
  - Emits `agentToolDone` (after delay)
  - Registers permission timer (non-exempt tool)

### OC-A2: Exempt tool does not register permission timer

- Input: exported OpenCode message containing assistant `tool` part for `question`
- Expected:
  - Emits activity events (`agentStatus`, `agentToolStart`, `agentToolDone`)
  - Does not add permission timer entry

### OC-A3: User message clears activity

- Input: previously active tool state + exported message with role `user`
- Expected:
  - Emits `agentToolsClear`
  - Emits `agentStatus: active`
  - Clears active tool maps

### OC-A4: Idempotent message processing by message ID

- Input: same exported payload processed twice
- Expected:
  - First pass emits expected events
  - Second pass emits no new events

### OC-A5: Unknown tool fallback naming

- Input: assistant tool with unrecognized name (`custom_tool_xyz`)
- Expected:
  - Emits `agentToolStart` status beginning with `Using custom_tool_xyz`

### OC-A6: Completed assistant turn sets waiting

- Input: assistant message with completion timestamp and no tool parts
- Expected:
  - Agent sets waiting state
  - Emits `agentStatus: waiting`

### OC-A7: Task tool emits subagent lifecycle events

- Input: assistant message with `task` tool part
- Expected:
  - Emits parent `agentToolStart` with `Subtask:` status
  - Emits `subagentToolStart`
  - Emits `subagentToolDone`
  - Emits `subagentClear`

## Manual Extension Host Cases

Run these in VS Code Extension Development Host (F5).

### OC-M1: Runtime switch persists

1. Open Settings modal
2. Toggle Agent Runtime to OpenCode
3. Reload webview (or reload window)
4. Re-open Settings

Expected: Runtime remains OpenCode.

### OC-M2: OpenCode launch path

1. Ensure runtime is OpenCode
2. Click `+ Agent`
3. Verify terminal name prefix is `OpenCode #...`

Expected: New agent appears and terminal launches OpenCode.

### OC-M3: Tool animation mapping

1. In OpenCode agent terminal, run a prompt that triggers tools (`read`, `grep`, `bash`)
2. Observe character state and overlay text

Expected: Character becomes active during tools, status labels map to existing behaviors, and returns to waiting when response completes.

### OC-M4: Claude regression check

1. Switch runtime back to Claude
2. Launch new agent
3. Run a tool-using prompt

Expected: Existing Claude JSONL flow still works unchanged.

## Execution Commands

- Automated parser tests:
  - `npx tsx scripts/opencode-integration-tests.ts`
- Full build verification:
  - `npm run build`
