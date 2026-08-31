import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as AutoCorrect from '@deepseek-ai/dsh-auto-correct'
import type { Config } from '@deepseek-ai/dsh-auto-correct'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const testToolSignal = new AbortController().signal

/** Boot the core spine + the guard; the caller registers extra listeners. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // AgentLoop injects `sessionProjections`; the testkit does not mount it.
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AutoCorrect, config)
  // A stand-in for the real pwsh tool: the middleware keys on the tool NAME
  // and the argument shape, not on the shell implementation.
  ctx.tools.register(defineContentToolFixture({
    name: 'pwsh',
    description: 'run a PowerShell command',
    parameters: {},
    async execute() { return [{ type: 'text', text: 'ran' }] },
  }))
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
}

/** Joined text of a tool result's content blocks. */
function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('|')
}

describe('unwrapCommand', () => {
  it('unwraps a JSON-envelope string into its inner command', () => {
    expect(AutoCorrect.unwrapCommand('{"command":"Get-Process"}')).toBe('Get-Process')
    expect(AutoCorrect.unwrapCommand(' { "cmd" : "python run.py" } ')).toBe('python run.py')
  })

  it('unwraps an object command value', () => {
    expect(AutoCorrect.unwrapCommand({ command: 'Get-Process' })).toBe('Get-Process')
    expect(AutoCorrect.unwrapCommand({ cmd: 'dir' })).toBe('dir')
  })

  it('leaves plain command text untouched', () => {
    expect(AutoCorrect.unwrapCommand('Get-Process')).toBeUndefined()
    expect(AutoCorrect.unwrapCommand('$code = Get-Content x; Write-Output $code')).toBeUndefined()
  })

  it('treats `{`-leading garbage and empty payloads as unrecoverable', () => {
    expect(AutoCorrect.unwrapCommand('{ not json')).toBeUndefined()
    expect(AutoCorrect.unwrapCommand({ command: '   ' })).toBeUndefined()
    expect(AutoCorrect.unwrapCommand(42)).toBeUndefined()
    expect(AutoCorrect.unwrapCommand(null)).toBeUndefined()
  })
})

describe('commandIssue', () => {
  it('is clean for a plain command string', () => {
    expect(AutoCorrect.commandIssue({ command: 'Get-Process' })).toBeUndefined()
    expect(AutoCorrect.commandIssue({ command: '$x=1; Get-Process -Name x' })).toBeUndefined()
  })

  it('flags an object-wrapped command and repairs it', () => {
    const issue = AutoCorrect.commandIssue({ command: { command: 'Get-Process' } })
    expect(issue?.problem).toContain('不是纯命令文本')
    expect(issue?.corrected).toBe('Get-Process')
  })

  it('flags a JSON-envelope string command and repairs it', () => {
    const issue = AutoCorrect.commandIssue({ command: '{"command":"Get-Process"}' })
    expect(issue?.problem).toContain('内嵌了 JSON 结构')
    expect(issue?.corrected).toBe('Get-Process')
  })

  it('flags an in-text JSON envelope without an exact repair', () => {
    const issue = AutoCorrect.commandIssue({ command: 'Get-Process {"command":"x"}' })
    expect(issue?.problem).toContain('内部包含 JSON 语法结构')
    expect(issue?.corrected).toBe('')
  })

  it('flags a non-text command value', () => {
    const issue = AutoCorrect.commandIssue({ command: 42 })
    expect(issue?.problem).toContain('必须是纯命令字符串')
  })
})

describe('coerceIssue type coercion', () => {
  it('flags a stringified timeout_ms and repairs the full arguments object', () => {
    const issue = AutoCorrect.coerceIssue('job_output', { job_id: 'pwsh-53', timeout_ms: '1800000' })
    expect(issue?.problem).toContain('应为数字')
    expect(issue?.corrected).toBe('1800000')
    expect(issue?.correctedArguments).toEqual({ job_id: 'pwsh-53', timeout_ms: 1800000 })
  })

  it('flags a stringified boolean and repairs it', () => {
    const issue = AutoCorrect.coerceIssue('pwsh', { command: 'Get-Process', run_in_background: 'true' })
    expect(issue?.problem).toContain('应为布尔值')
    expect(issue?.correctedArguments).toEqual({ command: 'Get-Process', run_in_background: true })
  })

  it('leaves correct types and unrelated strings untouched', () => {
    expect(AutoCorrect.coerceIssue('job_output', { timeout_ms: 1800000 })).toBeUndefined()
    expect(AutoCorrect.coerceIssue('pwsh', { command: 42 })).toBeUndefined()
    expect(AutoCorrect.coerceIssue('pwsh', { command: 'Get-Process', timeout_ms: 'not-a-number' })).toBeUndefined()
    expect(AutoCorrect.coerceIssue('pwsh', { command: 'Get-Process', foo: '120' })).toBeUndefined()
    expect(AutoCorrect.coerceIssue('pwsh', null)).toBeUndefined()
  })

  it('flags a quote-wrapped whole-string value and unwraps it', () => {
    const issue = AutoCorrect.coerceIssue('job_output', { job_id: '"pwsh-1"', timeout_ms: 180000 })
    expect(issue?.problem).toContain('被引号包裹')
    expect(issue?.corrected).toBe('pwsh-1')
    expect(issue?.correctedArguments).toEqual({ job_id: 'pwsh-1', timeout_ms: 180000 })
  })
})

describe('middleware deny', () => {
  it('denies a malformed pwsh call with the corrected command, allowing the clean one', async () => {
    const ctx = await harness()
    const denied = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('bad'),
      name: 'pwsh',
      arguments: { command: { command: 'Get-Process' } },
    })
    expect(denied.isError).toBe(true)
    const text = resultText(denied)
    expect(text).toContain('[dsh-auto-correct]')
    expect(text).toContain('修正后的 command')
    expect(text).toContain('Get-Process')

    const allowed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('good'),
      name: 'pwsh',
      arguments: { command: 'Get-Process' },
    })
    expect(allowed).toMatchObject({ isError: false })
    expect(resultText(allowed)).toBe('ran')
  })

  it('delegates tools outside the policed list', async () => {
    const ctx = await harness()
    ctx.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'p',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('probe'),
      name: 'probe',
      arguments: { command: { command: 'x' } },
    })
    expect(result).toMatchObject({ isError: false })
    expect(resultText(result)).toBe('ok')
  })

  it('denies a stringified timeout_ms on ANY tool with the corrected arguments JSON', async () => {
    const ctx = await harness()
    ctx.tools.register(defineContentToolFixture({
      name: 'job_output',
      description: 'read a job result',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    const denied = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('bad-ms'),
      name: 'job_output',
      arguments: { job_id: 'pwsh-53', timeout_ms: '1800000' },
    })
    expect(denied.isError).toBe(true)
    const text = resultText(denied)
    expect(text).toContain('[dsh-auto-correct]')
    expect(text).toContain('修正后的 arguments')
    expect(text).toContain('"timeout_ms":1800000')

    // The corrected shape passes without interception.
    const allowed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('good-ms'),
      name: 'job_output',
      arguments: { job_id: 'pwsh-53', timeout_ms: 1800000 },
    })
    expect(allowed).toMatchObject({ isError: false })
  })

  it('denies a quote-wrapped string field with the corrected arguments JSON', async () => {
    const ctx = await harness()
    ctx.tools.register(defineContentToolFixture({
      name: 'job_output',
      description: 'read a job result',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    // Real observed defect: `"job_id": "\"pwsh-1\""` — the value is the literal
    // `"pwsh-1"` (quotes included), so the lookup fails with an unknown-job
    // error. The middleware must deny and hand back the inner string.
    const denied = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('quoted-job'),
      name: 'job_output',
      arguments: { job_id: '"pwsh-1"', timeout_ms: 180000 },
    })
    expect(denied.isError).toBe(true)
    const text = resultText(denied)
    expect(text).toContain('[dsh-auto-correct]')
    expect(text).toContain('被引号包裹')
    expect(text).toContain('"job_id":"pwsh-1"')

    const allowed = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('clean-job'),
      name: 'job_output',
      arguments: { job_id: 'pwsh-1', timeout_ms: 180000 },
    })
    expect(allowed).toMatchObject({ isError: false })
  })
})

describe('unwrapQuoted', () => {
  it('unwraps double- and single-quoted whole-string values', () => {
    expect(AutoCorrect.unwrapQuoted('"pwsh-1"')).toBe('pwsh-1')
    expect(AutoCorrect.unwrapQuoted("'pwsh-1'")).toBe('pwsh-1')
  })

  it('leaves clean strings and quote-containing strings untouched', () => {
    expect(AutoCorrect.unwrapQuoted('pwsh-1')).toBeUndefined()
    expect(AutoCorrect.unwrapQuoted('"a" b"')).toBeUndefined()
    expect(AutoCorrect.unwrapQuoted('')).toBeUndefined()
    expect(AutoCorrect.unwrapQuoted('"')).toBeUndefined()
  })
})

describe('prompt hygiene section', () => {
  it('contributes the auto-correct section after the persona', async () => {
    const ctx = await harness()
    const assembly = await ctx.systemPrompt.assemble()
    const section = assembly.sections.find(s => s.name === 'auto-correct')
    expect(section).toBeDefined()
    expect(section?.text).toContain('arguments.command 必须是纯命令文本')
    expect(section?.text).toContain('old_string 必须从最近的 read/grep 输出逐字复制')
    // Assembly exposes sections in registry order: the hygiene section sits
    // right after the (dropped-empty) persona — first contributed section.
    expect(assembly.sections.indexOf(section!)).toBeGreaterThan(0)
  })

  it('omits the section when disabled', async () => {
    const ctx = await harness({ promptSection: false })
    const assembly = await ctx.systemPrompt.assemble()
    expect(assembly.sections.some(s => s.name === 'auto-correct')).toBe(false)
  })
})

describe('edit mismatch nudge', () => {
  it('attaches the corrective notice after an old_string-mismatch edit failure', async () => {
    const ctx = await harness()
    ctx.tools.register(defineContentToolFixture({
      name: 'edit',
      description: 'edit a file',
      parameters: {},
      async execute() {
        throw new Error('old_string was not found in "LiveStrategy.vue"')
      },
    }))
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('bad-edit'),
      name: 'edit',
      arguments: {
        file_path: 'D:\\\\dev\\\\Pyweb\\\\src\\\\views\\\\LiveStrategy.vue',
        old_string: 'getLiveStrategyOrders(50, strat)',
        new_string: 'getLiveStrategyOrders(500, strat)',
      },
    })
    expect(result.isError).toBe(true)
    // The raw tool refusal is preserved...
    expect(resultText(result)).toContain('old_string was not found')
    // ...and the corrective notice rides along as additional context.
    const nudge = (result.additionalContexts ?? []).find(ctx0 =>
      ctx0.content.some(block => block.type === 'text' && (block as { text: string }).text.includes('[dsh-auto-correct]')))
    expect(nudge).toBeDefined()
    expect(nudge?.content.map(b => b.type === 'text' ? (b as { text: string }).text : '').join(''))
      .toContain('old_string 与目标文件内容不匹配')
    expect(nudge?.content.map(b => b.type === 'text' ? (b as { text: string }).text : '').join(''))
      .toContain('逐字复制')
  })

  it('leaves successful edits and unrelated failures untouched', async () => {
    const ctx = await harness()
    ctx.tools.register(defineContentToolFixture({
      name: 'edit',
      description: 'edit a file',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'edited' }] },
    }))
    const ok = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ok-edit'),
      name: 'edit',
      arguments: { file_path: 'x', old_string: 'a', new_string: 'b' },
    })
    expect(ok).toMatchObject({ isError: false })
    expect(ok.additionalContexts ?? []).toHaveLength(0)

    ctx.tools.register(defineContentToolFixture({
      name: 'boom',
      description: 'throws unrelated',
      parameters: {},
      async execute() { throw new Error('disk full') },
    }))
    const unrelated = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('boom'),
      name: 'boom',
      arguments: {},
    })
    expect(unrelated.isError).toBe(true)
    expect(unrelated.additionalContexts ?? []).toHaveLength(0)
  })

  it('skips the nudge when editNudge is disabled', async () => {
    const ctx = await harness({ editNudge: false })
    ctx.tools.register(defineContentToolFixture({
      name: 'edit',
      description: 'edit a file',
      parameters: {},
      async execute() {
        throw new Error('old_string was not found in "LiveStrategy.vue"')
      },
    }))
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('bad-edit'),
      name: 'edit',
      arguments: { file_path: 'x', old_string: 'a', new_string: 'b' },
    })
    expect(result.isError).toBe(true)
    expect(result.additionalContexts ?? []).toHaveLength(0)
  })
})

describe('agent-loop retry', () => {
  it('feeds the correction hint back so the model can retry with a clean call', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c0', 'pwsh', { command: { command: 'Get-Process' } }),
      // The loop re-requests after the denial; script the repaired call and a stop.
      toolCallResponse('c1', 'pwsh', { command: 'Get-Process' }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // End-to-end contract: the denied call's correction hint must ride back
    // into the NEXT model request (that is the auto-correction loop), and the
    // repaired call must run afterwards.
    expect(adapter.requests.length).toBeGreaterThanOrEqual(2)
    const secondText = adapter.requests[1]!.messages
      .flatMap(m => m.content.flatMap(block =>
        block.type === 'text' ? [(block as { text: string }).text]
          : block.type === 'tool-result'
            ? (block as { content: { type: string; text?: string }[] }).content
              .filter(b => b.type === 'text')
              .map(b => (b as { text: string }).text)
            : []))
      .join('\n')
    expect(secondText).toContain('[dsh-auto-correct]')
    expect(secondText).toContain('Get-Process')
    // The repaired call ran the fixture body and the loop proceeded past it.
    expect(adapter.requests.length).toBe(3)
  })
})
