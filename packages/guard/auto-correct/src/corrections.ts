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
 * Type-coercion defect detection, applied to EVERY tool call: an argument with
 * a known numeric field name whose value is a stringified number, or a known
 * boolean field name whose value is a `"true"`/`"false"` string, is the
 * recurring `invalid arguments: "X" must be a number/boolean` defect. The
 * repair is the full corrected arguments object the model can copy verbatim.
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
  }
  return undefined
}
