/**
 * Auto-correct middleware, guard-tier. Two layers:
 *
 * 1. A `tools/pre-execute` waterfall listener that intercepts malformed
 *    shell-tool arguments (the recurring `arguments.command` written as a
 *    wrapped `{"command": ...}` JSON envelope or a non-text value) and DENIES
 *    the call with an actionable correction hint naming the exact repaired
 *    command to retry with. The harness freezes parsed arguments before
 *    policy, so the middleware corrects by steer-and-retry — the denial is
 *    the corrected instruction, and the agent loop feeds it back to the model
 *    deterministically, which is why the next attempt usually carries the
 *    repaired value. Silent in-place rewriting is architecturally excluded
 *    (see `PreToolDecision`'s contract).
 *
 * 2. A system-prompt section (order 100, immediately after the deployment
 *    persona) stating the hygiene rules, so most malformed calls never happen.
 *
 * @module @deepseek-ai/dsh-auto-correct
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { coerceIssue, commandIssue, containsJsonEnvelope, unwrapCommand, unwrapQuoted } from './corrections.ts'
import type { AutoCorrectIssue } from './corrections.ts'

export { coerceIssue, commandIssue, containsJsonEnvelope, unwrapCommand, unwrapQuoted }
export type { AutoCorrectIssue } from './corrections.ts'

/** Cordis plugin name. */
export const name = 'auto-correct'

/** The prompt registry this guard contributes its hygiene section to. */
export const inject = ['systemPrompt'] as const

/** Prompt slot of the hygiene section: right after the persona slot (0). */
const SECTION_ORDER = 100

/** Unique section name; equal orders disambiguate by name, so this stays stable. */
const SECTION_NAME = 'auto-correct'

/** Plugin config. */
export interface Config {
  /** Tool names the middleware polices (default `['pwsh']`). */
  tools?: string[]
  /** Register the prompt hygiene section (default `true`). */
  promptSection?: boolean
  /** Deny malformed calls with a correction hint (default `true`). */
  denyMalformed?: boolean
  /**
   * Apply type coercion to EVERY tool call: stringified numbers in numeric
   * fields and `"true"`/`"false"` strings in boolean fields are denied with
   * the full corrected arguments JSON (default `true`).
   */
  coerceTypes?: boolean
}

export const Config: z<Config> = z.object({
  tools: z.array(z.string()).default(['pwsh']),
  promptSection: z.boolean().default(true),
  denyMalformed: z.boolean().default(true),
  coerceTypes: z.boolean().default(true),
})

/** The hygiene rules the system-prompt section contributes. */
const HYGIENE_RULES =
  '自动纠错规则(dsh-auto-correct):\n'
  + '- 调用 pwsh 时,arguments 必须是 JSON 对象,arguments.command 必须是纯命令文本。\n'
  + '- arguments.command 不能以 { 开头,不能内嵌 {\"command\": ...} 或 {\"arguments\": ...} 这类 JSON 结构。\n'
  + '- 命令应直接以可执行命令开头(如 $env:、Get-Process、python、cmd /c),不要在 command 里再包一层 JSON。\n'
  + '- 参数类型必须正确:数值字段(timeout_ms、limit、max_tokens 等)必须传数字,不能传字符串;布尔字段(run_in_background、checked、enabled 等)必须传 true/false,不能传 "true"/"false" 字符串。\n'
  + '- 字符串字段不要整个再用引号包一层:如 {"job_id": "\\"pwsh-1\\""} 应写成 {"job_id": "pwsh-1"},否则工具会拿到带引号的值导致查找失败。'

/**
 * Build the model-facing denial reason from a detected defect: it states the
 * problem and, whenever recoverable, the EXACT command text to retry with.
 */
function correctionReason(toolName: string, issue: AutoCorrectIssue): string {
  let text = `[dsh-auto-correct] 工具 ${toolName} 的参数格式有误,已自动拦截本次调用。\n`
    + `- 问题: ${issue.problem}\n`
  if (issue.correctedArguments !== undefined) {
    text += '- 请用以下修正后的 arguments 重新调用(可直接复制):\n'
      + `${JSON.stringify(issue.correctedArguments)}\n`
  } else if (issue.corrected.length > 0) {
    text += `- 请用以下修正后的 command 立即重新调用:\n${issue.corrected}\n`
  } else {
    text += '- 请重新生成本次调用,将参数修正为正确类型(纯命令文本 / 数字 / 布尔值,按字段要求)。\n'
  }
  return text
}

/**
 * Validate `tools` fail-loud (an empty or duplicated list is a composition
 * bug) and return the policed set.
 */
function validateTools(values: string[]): Set<string> {
  if (values.length === 0) {
    throw new Error('dsh-auto-correct: `tools` must not be empty')
  }
  if (new Set(values).size !== values.length) {
    throw new Error('dsh-auto-correct: `tools` must not contain duplicates')
  }
  return new Set(values)
}

/**
 * Install the guard's listeners and prompt contribution.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated {@link Config}; re-checked fail-loud in `apply`.
 */
export function apply(ctx: Context, config: Config): void {
  const tools = validateTools(config.tools as string[])
  const promptSection = config.promptSection as boolean
  const denyMalformed = config.denyMalformed as boolean

  if (promptSection) {
    // Global unique-name section: register directly (the `ctx.effect` wrapper
    // belongs to slot-REPLACING rows like the persona; a new section registers
    // like `tool:web_search` does).
    ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: HYGIENE_RULES,
    })
  }

  if (denyMalformed) {
    const coerceTypes = config.coerceTypes as boolean

    // Waterfall: delegate clean calls, deny detectable defects with the repair
    // instruction the loop feeds back to the model on the retry.
    ctx.on('tools/pre-execute', async (exec: ToolExecution, next): Promise<PreToolDecision> => {
      // Type coercion applies to EVERY tool call, not just the policed list:
      // `"timeout_ms": "1800000"` and `"run_in_background": "true"` style
      // defects are cross-tool recurring failures.
      if (coerceTypes) {
        const coercible = coerceIssue(exec.name, exec.arguments)
        if (coercible !== undefined) {
          return { kind: 'deny', reason: correctionReason(exec.name, coercible) }
        }
      }
      if (!tools.has(exec.name)) return next()
      const issue = commandIssue(exec.arguments)
      if (issue === undefined) return next()
      return { kind: 'deny', reason: correctionReason(exec.name, issue) }
    })
  }
}
