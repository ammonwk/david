import { describe, expect, it } from 'vitest';
import { normalizeAgentOutput } from '../src/components/agents/terminalOutput';

describe('normalizeAgentOutput', () => {
  it('extracts assistant text from historical protocol frames', () => {
    const output = normalizeAgentOutput([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"First line\\nSecond line"}]}}',
    ]);

    expect(output).toEqual([
      { kind: 'assistant', text: 'First line' },
      { kind: 'assistant', text: 'Second line' },
    ]);
  });

  it('parses Claude tool_use blocks into readable tool lines', () => {
    const output = normalizeAgentOutput([
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}',
    ]);

    expect(output).toEqual([
      { kind: 'tool', text: '$ git status' },
    ]);
  });

  it('parses Claude streaming text deltas', () => {
    const output = normalizeAgentOutput([
      '{"type":"stream_event","subtype":"content_block_delta","delta":{"type":"text_delta","text":"Streaming line"}}',
    ]);

    expect(output).toEqual([
      { kind: 'assistant', text: 'Streaming line' },
    ]);
  });

  it('summarizes codex command payloads instead of dumping the full JSON envelope', () => {
    const output = normalizeAgentOutput([
      '{"type":"item.completed","item":{"id":"item_41","type":"command_execution","command":"/bin/bash -lc \\"npm test\\"","exit_code":0,"status":"completed","aggregated_output":"very long output"}}',
    ]);

    expect(output).toEqual([
      { kind: 'tool', text: '$ /bin/bash -lc "npm test" (completed, exit 0)' },
    ]);
  });

  it('parses codex agent messages', () => {
    const output = normalizeAgentOutput([
      '{"type":"item.started","item":{"id":"msg_1","type":"agent_message","text":"Investigating failure\\nChecking tests"}}',
    ]);

    expect(output).toEqual([
      { kind: 'assistant', text: 'Investigating failure' },
      { kind: 'assistant', text: 'Checking tests' },
    ]);
  });

  it('keeps lifecycle lines readable', () => {
    const output = normalizeAgentOutput([
      '[lifecycle] restarting (attempt 1/2) after 5000ms backoff',
    ]);

    expect(output).toEqual([
      { kind: 'system', text: '[lifecycle] restarting (attempt 1/2) after 5000ms backoff' },
    ]);
  });
});
