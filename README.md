# dsh-live2d-bridge

把 DSH 会话事件压成一份状态文件，供 **Live2D Stage**（独立 Electron 舞台）读取，
驱动角色气泡、表情与动作。

## 为什么是文件

DSH 的 Web 端口带鉴权（外部进程直接请求返回 401），插件里注册的 `/xxx.json` 路由只对页面内同源可用。
Live2D 舞台是**另一个进程**，所以这里原子写文件（tmp → rename），舞台侧轮询即可：无鉴权、无端口冲突。

## 输出

`%USERPROFILE%\.dsh\live2d\status.json`

```json
{
  "ok": true,
  "v": 1,
  "at": 1793420612258,
  "state": "working",
  "task": "改 renderer 的气泡定位",
  "tool": "ops_bash",
  "session": "session-…",
  "states": ["thinking", "working", "result", "waiting", "success", "error"]
}
```

| 字段 | 含义 |
| --- | --- |
| `state` | 六档之一，`null` = 空闲（回合结束并过了展示窗口 / 没有活跃会话） |
| `task` | `todo/write` 里的当前步骤（in_progress 优先，其次第一个 pending），最多 48 字 |
| `tool` | 最近一次 `tool/call` 的工具名 |
| `at` | 状态最后变化的时间戳（舞台用它去重） |

## 状态判据（与 dsh-xiaoke-widget / dsh-pet 的 work-status 一致）

- `turn/start` → `thinking`
- `tool/call` → `working`（`ask_user_question` → `waiting`）
- `tool/result` → `result`
- `approval/asked` → `waiting`
- `turn/end`：`completed` → `success`，`error`/`max-tokens`/`timeout` → `error`，`blocked` → `waiting`
- 终态保留 60 秒后自动清除，回到 `null`

多会话同时活跃时按优先级挑一个展示：`waiting > error > working > thinking > result > success`，同档取最近更新。

## 模型可调用的工具

插件注册两个工具（舞台开着才生效，没开返回 `ok:false` 而不是报错）：

- `live2d` —— 控制角色。`kind` 取 `say / expression / pose / look / idle / state / stop`；
  配合 `text`（说什么）、`name`（表情 / 姿势 / 待机动作 / 状态名）、`x` / `y`（视线，-1..1）、
  `ms`（时长）、`task`（state 时显示在气泡里的当前步骤）。
- `live2d_status` —— 读回气泡文字、待机动作、表情层，以及 `feedback` 里最近的点/摸/拖记录。

调用不经过 DSH 的 Web 端口：读舞台写下的 `~/.dsh/live2d/endpoint.json`，直接请求舞台本机的 HTTP API
（`/api/action`、`/api/state`、`/api/feedback`）。

## 约束

- 只 import node 内置模块 + `@deepseek-ai/dsh-tools`（peer 依赖，运行时由 DSH 提供）
- 只观察不改流程：不拦截审批/问答，任何异常自己吞掉
- 卸载时清定时器，不删状态文件（舞台读不到新状态就按空闲处理，文件留着方便排查）
