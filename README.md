# @240xu/dsh-message-ops

DSH web 插件：**消息回滚 + 消息删除 + 消息分支** 三合一。在会话头部添加分支图标按钮，
侧栏会话行 "..." 菜单注入「消息操作」项，打开统一操作对话框：

- **回滚（Revert）**：遮蔽所选消息及其后的全部可见内容（DSH 原生 surface replace 语义）。
  日志 append-only，原事件完整保留，语境可通过重新发送恢复。
- **删除（Delete）**：仅遮蔽所选的那一条消息，其余内容不变（同样是 surface replace）。
- **分支（Branch）**：把所选消息（含）之前的全部事件复制为一个**新会话**，
  新会话 header 携带 `parentSession=<原会话 id>`，原会话一个字节都不动 —— 唯一的非破坏操作。

## 安装

零 npm 依赖（只用 `node:fs` / `node:zlib` / `node:path` / `node:url`；zstd 压缩走
Node 内建 `zlib.zstdCompressSync`，需 **Node ≥ 23.5**，Termux 与 Windows 通用）。

```sh
# Termux / Linux
dsh plugin --profile web add @240xu/dsh-message-ops

# Windows
dsh plugin --profile web add @240xu/dsh-message-ops
# 或本地目录：
dsh plugin --profile web add file:C:/path/to/dsh-message-ops
```

重启 DSH web 实例后生效。

## 安全设计

- 回滚/删除不重写日志：通过一条承载 `surfaceOp: replace` 的 system 事件实现，
  约束由 DSH 引擎 `assertProvenance` 校验，违规如实上报（HTTP 409）。
- 回滚/删除前必须勾选风险确认；运行中的会话一律拒绝（提示先停止）。
- 分支先写临时文件再原子 rename，半写日志不会被会话扫描读到。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET  | `/api/message-ops/messages?sessionId=<id>` | 消息级列表（磁盘真相 + 可见性标注 + running 状态） |
| POST | `/api/message-ops/revert`  | `{sessionId, seq}` 回滚到该条（含） |
| POST | `/api/message-ops/delete`  | `{sessionId, seq}` 仅遮蔽该条 |
| POST | `/api/message-ops/branch`  | `{sessionId, upToSeq}` 分支新会话，返回 `{newId, dir, keptEvents}` |

## 开发

```sh
node --test test/   # 7 个零依赖测试
```

格式兼容性已对真实会话日志验证（多帧 v3 格式；旧单帧 `session.jsonl.zstd` 读取走同一帧扫描路径）。

## License

MIT
