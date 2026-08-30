# dsh-auto-correct 独立安装(目标机器无 DSH 源码)

本插件是标准 npm 包,可以单独装进任何一份**已构建好的 dsh 安装**(不需要仓库源码)。

## 前置条件

- 目标机器上有完整的 dsh 安装(它的 `node_modules/@deepseek-ai/` 里已有
  `dsh-tools`、`dsh-system-prompt`、`cordis` —— 这是插件的 peer 依赖)。
- 目标 dsh 版本的这些依赖与插件兼容(同仓库同一发布周期产物即可)。

## 安装步骤

### 1. 拿到插件安装包

在**有源码的机器**上已生成 tarball(构建 `pnpm build` 后):

```
packages/guard/auto-correct/deepseek-ai-dsh-auto-correct-0.1.0-alpha.1.tgz
```

把它拷贝到目标机器(USB/网络均可,约 20KB)。

### 2. 装进 dsh 的依赖

在 dsh 安装根目录执行(目标机器没有仓库依赖树,用 `--legacy-peer-deps` 跳过
`workspace:` 协议的 peer 校验):

```bash
npm install --prefix <dsh-root> --legacy-peer-deps ./deepseek-ai-dsh-auto-correct-0.1.0-alpha.1.tgz
```

或手工放置(等价,适合不想动依赖树的情况):

```
<dsh-root>/node_modules/@deepseek-ai/dsh-auto-correct/
  ├── package.json
  ├── lib/index.js
  ├── lib/invariant.js
  └── lib/types/index.d.ts
```

### 3. 接进组合(官方 --patch 机制)

把仓库里同目录的 `standalone.patch.yml` 拷到目标机器,然后在启动 dsh 时追加
patch 参数:

```bash
dsh web --patch ./standalone.patch.yml
```

> 安装型入口的等价形式:`your-dsh-bin web --patch ./standalone.patch.yml`
> (与仓库内 `demo:inspector` 用的 `web --patch <file>` 是同一机制)。

### 4. 验证

1. 新会话系统提示词中出现 `自动纠错规则(dsh-auto-correct)` 段
   (GUI 每条消息旁「系统提示词」展开行可查)。
2. 行为验证:让 agent 传 `"timeout_ms": "1800000"`(应为数字)或给 pwsh 的
   `command` 包一层 `{"command": ...}` —— 应看到 `[dsh-auto-correct]` 拒绝
   原因,并携带修正后的完整 arguments JSON / 修正命令,下一次调用自动用修正值。
3. 想回归测试:有源码环境跑
   `pnpm exec vitest run packages/guard/auto-correct/tests/auto-correct.spec.ts`
   (18/18)。

## 配置项(standalone.patch.yml 内)

| 键 | 默认 | 说明 |
|---|---|---|
| `tools` | `[pwsh]` | 命令信封规则受管工具名 |
| `promptSection` | `true` | 是否注册卫生提示词段 |
| `denyMalformed` | `true` | 是否拦截坏调用并给出修正值 |
| `coerceTypes` | `true` | 跨工具类型强制(数字/布尔字段) |

## 依赖与版本注意

- peerDependencies:`cordis`、`dsh-tools`、`dsh-system-prompt`(仓库内为
  `workspace:^`,独立安装时由目标 dsh 提供,`--legacy-peer-deps` 避免 npm 对
  `workspace:` 协议报错)。
- 若目标 dsh 是正式发布版(npm registry 安装),改为 `npm i @deepseek-ai/dsh-auto-correct`
  即可——发布管线会按正式 semver 处理依赖。