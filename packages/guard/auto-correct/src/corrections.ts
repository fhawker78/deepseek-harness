/**
 * Pure correction logic for the auto-correct guard: detection of the known
 * malformed tool-call argument shapes and the corrected command text a denied
 * call should retry with. Kept free of any runtime imports so unit tests can
 * exercise every branch without mounting a harness.
 * @module @deepseek-ai/dsh-auto-correct/corrections
 */

/** One detected, correctable defect in a policed tool call. */
export interface AutoCorrectIssue {
  /** The tool whose arguments carry the defect. */
  readonly tool: string
  /** Human-readable statement of what is wrong (model-facing). */
  readonly problem: string
  /** The corrected value the model should retry with ('' when not recoverable). */
  readonly corrected: string
  /** Full corrected arguments object the model may copy verbatim, when recoverable. */
  readonly correctedArguments?: Record<string, unknown>
}

/**
 * Argument field names that must be NUMBERS by convention across tools
 * (`timeout_ms`, `limit`, `max_tokens`, ...). A stringified number in one of
 * these is the recurring `"timeout_ms" must be a number` style defect.
 */
const NUMERIC_FIELDS = ['timeout_ms', 'timeoutMs', 'limit', 'max_tokens', 'maxTokens'] as const

/**
 * Argument field names that must be BOOLEANS by convention. A `"true"`/`"false"`
 * string or a `1`/`0` number in one of these is the recurring
 * `"run_in_background" must be a boolean` style defect.
 */
const BOOLEAN_FIELDS = ['run_in_background', 'checked', 'autoRefresh', 'auto_refresh', 'enabled'] as const

/**
 * Redundant sandbox escalation: the call carries `sandbox_permissions` (and
 * usually `justification`) even though the session is already at
 * `danger-full-access`. The sandbox layer requires a STRICTLY wider mode, so
 * the same-level escalation is rejected with
 * `sandbox escalation to "..." is not strictly wider than this call's current
 * mode`. The justification text usually tells the story ("当前会话已
 * full-access，无需更宽"); the correction drops both fields.
 */
export type RedundantSandboxIssue = AutoCorrectIssue

/** Phrases in `justification` that signal the call already runs full-access. */
const REDUNDANT_SANDBOX_MARKERS =
  /无需更宽|当前会话已|not strictly wider|already (?:at |in )?full|已.*(?:full|danger|更宽)/i

/**
 * Detect a redundant sandbox escalation pair on a shell-tool call. When the
 * `justification` states the call already runs full-access, the
 * `sandbox_permissions` field is necessarily rejected; the correction strips
 * both fields so the model can retry the exact same command cleanly.
 */
export function redundantSandboxIssue(args: unknown): RedundantSandboxIssue | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  const perms = record.sandbox_permissions
  const why = record.justification
  if (typeof perms !== 'string' || typeof why !== 'string') return undefined
  if (!REDUNDANT_SANDBOX_MARKERS.test(why)) return undefined
  const corrected: Record<string, unknown> = { ...record }
  delete corrected.sandbox_permissions
  delete corrected.justification
  return {
    tool: 'pwsh',
    problem: `arguments.sandbox_permissions 请求的级别(${perms})与会话当前级别相同,已无更宽模式可升,该字段必然被拒("not strictly wider")`,
    corrected: '',
    correctedArguments: corrected,
  }
}

/** Argument keys that mark a parsed object as the intended full argument set. */
const KNOWN_ARG_KEYS = new Set([
  'file_path', 'old_string', 'new_string', 'command', 'description', 'arguments',
  'job_id', 'timeout_ms', 'timeoutMs', 'limit', 'max_tokens', 'run_in_background',
  'query', 'path', 'pattern', 'agent_id', 'subagent_id', 'name', 'content',
  'prompt', 'message', 'output', 'value', 'tool',
])

/**
 * Whole-call double nesting: one STRING argument field contains the entire
 * intended argument object as text — e.g. `"file_path": "{file_path: ...,
 * old_string: ..., new_string: ...}"`. The call is wrapped one level too deep;
 * the inner parsed object IS the corrected arguments.
 */
export function nestedArgsIssue(tool: string, args: unknown): AutoCorrectIssue | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const value = record[key]
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) continue
    let inner: unknown
    try {
      inner = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) continue
    const innerKeys = Object.keys(inner as Record<string, unknown>)
    const hits = innerKeys.filter(k => KNOWN_ARG_KEYS.has(k))
    if (hits.length >= 2) {
      return {
        tool,
        problem: `arguments.${key} 整个被包成了 JSON 对象(内含 ${hits.join('/')} 等参数键),调用被嵌套了一层;应直接用内层对象作为 arguments`,
        corrected: '',
        correctedArguments: inner as Record<string, unknown>,
      }
    }
  }
  return undefined
}

/** Keys the middleware accepts as the real command payload inside a JSON envelope. */
const COMMAND_KEYS = ['command', 'cmd', 'Command'] as const

/**
 * Unwrap a command value that arrived inside a JSON envelope:
 * - a string that parses as a JSON object with a `command`/`cmd` key;
 * - an object with a string `command`/`cmd` property.
 * Returns the inner plain command text, or `undefined` when the value is
 * already a plain, usable command.
 */
export function unwrapCommand(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) return undefined
    try {
      return unwrapCommand(JSON.parse(trimmed) as unknown)
    } catch {
      return undefined // `{`-leading garbage is not an envelope we can repair
    }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of COMMAND_KEYS) {
      const inner = record[key]
      if (typeof inner === 'string' && inner.trim().length > 0) return inner
    }
  }
  return undefined
}

/**
 * A hard heuristic for an envelope that survived inside a longer command
 * string (e.g. `Get-Process {"command": "..."}`): JSON envelope syntax that
 * the model should never place inside a command text.
 */
export function containsJsonEnvelope(text: string): boolean {
  return /\{"(?:command|cmd|arguments)"\s*:/.test(text)
}

/**
 * Inspect the parsed `arguments` of a policed shell tool call. Returns the
 * defect and its repair when the `command` payload is wrapped or non-text;
 * `undefined` when the call is clean (the middleware should delegate).
 */
export function commandIssue(args: unknown): AutoCorrectIssue | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const command = (args as Record<string, unknown>).command

  if (typeof command === 'string') {
    const inner = unwrapCommand(command)
    if (inner !== undefined && inner !== command.trim()) {
      return {
        tool: 'pwsh',
        problem: 'arguments.command 内嵌了 JSON 结构(以 { 开头包了一层 {"command": ...})',
        corrected: inner,
      }
    }
    if (containsJsonEnvelope(command)) {
      return {
        tool: 'pwsh',
        problem: 'arguments.command 内部包含 JSON 语法结构(如 {"command": ...} / {"arguments": ...})',
        corrected: '',
      }
    }
    return undefined
  }

  const inner = unwrapCommand(command)
  if (inner !== undefined) {
    return {
      tool: 'pwsh',
      problem: 'arguments.command 不是纯命令文本(是一个 JSON 对象,应从其中取出 command 字符串)',
      corrected: inner,
    }
  }
  if (command === undefined) return undefined
  return {
    tool: 'pwsh',
    problem: 'arguments.command 必须是纯命令字符串,不能是其他类型',
    corrected: '',
  }
}

/**
 * A string whose ENTIRE value is wrapped in a matching pair of quote
 * characters — e.g. `"job_id": "\"pwsh-1\""` where the value is the literal
 * `"pwsh-1"` (quotes included). The tool receives the quotes and fails a
 * lookup/parse; the inner string is the intended value.
 */
export function unwrapQuoted(value: string): string | undefined {
  if (value.length < 2) return undefined
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    const inner = value.slice(1, -1)
    // A genuine string that happens to start and end with a quote would also
    // contain internal quotes; only a clean wrapper is unwrapped.
    if (!inner.includes(first)) return inner
  }
  return undefined
}

/**
 * Type/format-coercion defect detection, applied to EVERY tool call:
 * an argument with a known numeric field name whose value is a stringified
 * number, a known boolean field name whose value is a `"true"`/`"false"`
 * string, or ANY string value wrapped in an outer pair of quotes, is a
 * recurring `invalid arguments: "X" must be a number/boolean` or
 * lookup-failure defect. The repair is the full corrected arguments object
 * the model can copy verbatim.
 */
export function coerceIssue(tool: string, args: unknown): AutoCorrectIssue | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  for (const key of Object.keys(record)) {
    const value = record[key]
    if ((NUMERIC_FIELDS as readonly string[]).includes(key) && typeof value === 'string') {
      const trimmed = value.trim()
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const numeric = Number(trimmed)
        if (Number.isFinite(numeric)) {
          return {
            tool,
            problem: `arguments.${key} 是字符串 "${value}",而该字段应为数字`,
            corrected: String(numeric),
            correctedArguments: { ...record, [key]: numeric },
          }
        }
      }
    }
    if ((BOOLEAN_FIELDS as readonly string[]).includes(key) && (value === 'true' || value === 'false')) {
      return {
        tool,
        problem: `arguments.${key} 是字符串 "${value}",而该字段应为布尔值`,
        corrected: value,
        correctedArguments: { ...record, [key]: value === 'true' },
      }
    }
    if (typeof value === 'string') {
      const innerQuoted = unwrapQuoted(value)
      if (innerQuoted !== undefined) {
        return {
          tool,
          problem: `arguments.${key} 的值被引号包裹("${value}"),应使用内层字符串 "${innerQuoted}"`,
          corrected: innerQuoted,
          correctedArguments: { ...record, [key]: innerQuoted },
        }
      }
    }
  }
  return undefined
}
