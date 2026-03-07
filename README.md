# codex-viewer

`codex-viewer` 是一个给 Codex CLI 用的本地 sidecar：

- 通过 `codex app-server` 提供 Web / 手机端远程控制
- 通过本地捕获代理记录 Codex 发出的网络请求
- 提供会话、审批、命令输出和原始请求的统一界面

## Quick Start

### 一键启动（推荐）

先进入 `codex-viewer` 目录，然后在你要控制的项目目录中执行：

```bash
npm run start
```

- 默认公网监听：`0.0.0.0`
- 默认起始端口：`17777`（被占用会自动 +1）
- 自动使用当前目录作为 `workspace`
- 启动后终端会打印 `Pair URL`，手机直接访问即可

后台运行：

```bash
npm run start:bg
```

### 只需要时再加的参数（可选）

如果你希望生成固定公网链接（比如服务器有固定 IP/域名）：

```bash
npm run start -- --public-url http://<服务器IP或域名>:<端口>
```

如果你希望从其他起始端口尝试：

```bash
npm run start -- --web-port 18888
```

如果你希望指定 Codex 工作目录（两种方式都支持）：

```bash
npm run start -- --workspace /path/to/your/project
```

```bash
npm run start -- /path/to/your/project
```

```bash
node scripts/workspace-cli.js start /path/to/your/project
```

### 脚本方式（等价）

前台：

```bash
./start.sh
```

后台：

```bash
./start-bg.sh
```

## Useful Commands

```bash
npm run open
npm run status
npm run stop
```

## Notes

- v1 通过 `OPENAI_BASE_URL` + `HTTP(S)_PROXY`/`ALL_PROXY` 双路径尝试捕获出站请求。
- 若 Codex 通过 `CONNECT` 建立 TLS 隧道，v1 只能记录元数据，无法解密查看 HTTPS 负载。
- 公网访问建议通过反向代理暴露 `http://127.0.0.1:<port>`，例如 Caddy、Nginx 或 Tailscale Serve。
- 当前 UI 桌面端为三栏布局，手机端为简化单栏：主会话 + 底部操作，线程切换通过弹窗完成。
- 调试日志默认写入 `<workspace>/.codex-viewer/logs/codex-viewer.log`，可用 `--log-file` 自定义路径。

## 当前完成度（v0.1.x）

- ✅ 控制平面：已通过 `codex app-server` 实现线程创建、继续对话、流式输出、审批处理。
- ✅ 观测平面：已实现本地代理抓取并展示原始请求；在 `CONNECT` 模式下可展示元数据。
- ✅ Web 远控：支持浏览器登录、会话恢复、实时事件推送（WebSocket）。
- ✅ 手机访问：支持移动浏览器简化布局、线程切换、发送 prompt、处理 ask-user/审批。
- ✅ 公网测试：支持 `--web-host 0.0.0.0` 直接对外监听，并可通过 `--public-url` 生成可分享链接。
- ⚠️ 安全与部署：当前默认 HTTP 明文，生产环境仍建议 Nginx + HTTPS + 访问控制。

## 未来计划

- 近期（v0.2）
  - ask-user 交互增强：多问题自动校验、默认选项、一步提交体验优化。
  - 移动端可用性优化：固定底部导航、消息区更强自适应、长列表性能优化。
  - 请求观测增强：OpenAI/Codex 请求类型识别、按线程/turn 过滤与关联展示。
- 中期（v0.3）
  - 安全增强：细化设备会话管理、token 失效与轮换、基础审计日志导出。
  - 可靠性增强：断线重连恢复优化、子进程异常自愈、健康检查与告警提示。
- 长期（v1.0 方向）
  - 多端协同能力（单写多读之外的可控协作模型）。
  - 更完整的“对话-命令-请求”联动分析视图。
