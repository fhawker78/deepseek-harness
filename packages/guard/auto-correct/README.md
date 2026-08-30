# dsh-auto-correct

自动纠错中间件(guard 层)。它只做一件事:让“模型把工具参数写坏”这类老毛病
在发生时被**确定性修正**,而不是靠模型碰运气重试。

## 机制

1. **跨工具类型强制**(默认开启,作用于**全部**工具调用):数值字段
   (`timeout_ms`、`timeoutMs`、`limit`、`max_tokens`、`maxTokens`)的值若是
   数字字符串(如 `"timeout_ms": "1800000"`),或布尔字段
   (`run_in_background`、`checked`、`autoRefresh`、`auto_refresh`、`enabled`)
   的值若是 `"true"`/`"false"` 字符串,以 `deny` 拦截,并在拒绝原因里给出
   **修正后的完整 arguments JSON**(可直接复制重试)。

2. **`tools/pre-execute` 命令信封检查**:对受管工具(默认 `pwsh`)检查参数形状。
   当 `arguments.command` 是以下形态之一时,以 `deny` 拦截,并把**可直接
   重试的修正命令文本**写进拒绝原因:

   - `command` 是 JSON 对象(如 `{"command": {"command": "Get-Process"}}`)
   - `command` 是以 `{` 开头的 JSON 信封串(如 `{"command":"Get-Process"}`)
   - `command` 文本内部嵌了 `{"command": ...}` / `{"arguments": ...}` 语法
   - `command` 不是字符串

   代理循环会把拒绝原因回喂给模型,模型下一次调用通常直接带上修正值 ——
   这是本 harness 架构下“自动纠错”的正式形态(参看 `PreToolDecision`
   契约:参数在进入策略管线前已 deep-frozen,静默改写被架构显式排除)。

3. **提示词卫生段**(order 100,紧跟 persona):把书写规则写进系统提示词,
   让大部分坏调用在源头就不发生。

## 配置

```yaml
- id: auto-correct
  name: '@deepseek-ai/dsh-auto-correct'
  config:
    tools: [pwsh]          # 命令信封规则受管工具名,默认 [pwsh]
    promptSection: true    # 是否注册卫生提示词段,默认 true
    denyMalformed: true    # 是否拦截坏调用,默认 true
    coerceTypes: true      # 跨工具类型强制(数字/布尔),默认 true
```

## 边界

- 只在调用边界拦截+引导重试,不替执行(参数已冻结,无法静默改写)。
- 仅对 `tools` 列表内的工具生效;其他工具调用一律直接放行。
- 识别出的修正值只出现在拒绝原因里,不会伪造任何成功结果。
