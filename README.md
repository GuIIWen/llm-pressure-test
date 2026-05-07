# Pressure Server - LLM 压力测试模拟服务

模拟 LLM（DeepSeek R1）的流式/非流式 API 行为，用于网关、前端等组件的压力测试。

## 架构文档

- [部署架构文档](./docs/DEPLOYMENT_ARCHITECTURE.md)

## 文件结构

```
├── pressure_server_cluster.js   # 多核服务端
├── pressure_client.js           # 压测客户端
├── pressure_server.js           # 单核版（原始版本）
├── deploy.sh                    # 服务端部署/管理脚本
├── test.sh                      # 客户端测试脚本
├── docs/
│   └── DEPLOYMENT_ARCHITECTURE.md  # ELB/APIG/VPCEP/ECS/ModelArts 部署架构说明
└── cert/                        # TLS 证书目录
    ├── key.pem
    └── cert.pem
```

## 快速开始

```bash
# 1. 启动服务（无需证书，默认以 HTTP 模式运行）
./deploy.sh start

# 2. 运行测试（默认 100 并发，流式+非流式各半）
./test.sh --port 3000

# 3. 停止服务
./deploy.sh stop
```

## 服务端

### 证书与启动模式

服务端支持两种模式，自动检测：

| 证书状态 | 行为 |
|----------|------|
| 有证书（`cert/key.pem` + `cert/cert.pem`） | HTTPS `:4000` 处理业务，HTTP `:3000` 重定向到 HTTPS |
| 无证书 | 仅 HTTP `:3000` 直接处理业务，控制台输出 WARNING |

无需手动配置，检测到证书不可用时会自动降级为纯 HTTP 模式。

### 部署管理

```bash
./deploy.sh start      # 启动
./deploy.sh stop       # 停止
./deploy.sh restart    # 重启
./deploy.sh status     # 查看进程和端口状态
./deploy.sh log        # 查看实时日志
```

### 环境变量

通过环境变量覆盖默认配置：

```bash
WORKERS=8 \
HTTPS_PORT=8443 \
HTTP_PORT=8080 \
CERT_KEY=/etc/ssl/server.key \
CERT_CERT=/etc/ssl/server.crt \
./deploy.sh start
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `WORKERS` | Worker 进程数（CPU 核数） | 4 |
| `HTTPS_PORT` | HTTPS 服务端口 | 4000 |
| `HTTP_PORT` | HTTP 重定向端口 | 3000 |
| `CERT_KEY` | TLS 私钥文件路径 | ./cert/key.pem |
| `CERT_CERT` | TLS 证书文件路径 | ./cert/cert.pem |

无证书启动时通过环境变量指定可跳过自动检测：

```bash
# 仅 HTTP 模式（默认行为，无需额外操作）
./deploy.sh start

# 指定证书后同时启动 HTTPS + HTTP
CERT_KEY=/etc/ssl/server.key CERT_CERT=/etc/ssl/server.crt ./deploy.sh start
```

### 代码内配置

编辑 `pressure_server_cluster.js` 顶部的 `CONFIG` 对象：

```js
const CONFIG = {
  workers: 4,                          // Worker 数
  maxBodyLength: 1024 * 1024,          // 请求体上限 (1MB)
  fixedResponseLength: 64,             // 非流式响应固定字符数，0=按输入×随机倍数
  latency: {
    ttft: 500,                         // Time To First Token (ms)
    tpot: 50                           // Time Per Output Token (ms)
  },
  stream: {
    minMultiplier: 1,                  // 响应长度最小倍数
    maxMultiplier: 10                  // 响应长度最大倍数
  }
};
```

### API 路由

| 路由 | 方式 | 说明 |
|------|------|------|
| `/deepseek-r1-tx/v1/chat` | POST | 流式响应 (SSE)，逐字输出 |
| `/deepseek-r1-tx/v1/chat/completions` | POST | 非流式响应，完整 JSON 一次性返回 |

### 延迟模型

模拟真实 LLM 推理的两个阶段：

```
请求到达
  │
  ├── TTFT (500ms) ─── 模拟 prefill/思考阶段
  │
  ├── 首 Token ─── 流式: 立即发出; 非流式: 进入累计延迟
  │
  ├── TPOT (50ms) ─── 每个 Token 的间隔
  ├── TPOT (50ms)
  ├── ...
  │
  └── 响应完成
```

- **流式**：先等 TTFT，然后每 TPOT 发一个字符
- **非流式**：总延迟 = TTFT + TPOT × token 数（上限 30s）

## 客户端

### 直接使用

```bash
node pressure_client.js [选项]
```

| 参数 | 短写 | 说明 | 默认值 |
|------|------|------|--------|
| `--host` | | 目标地址 | 127.0.0.1 |
| `--port` | | 目标端口 | 4000 |
| `--mode` | | `stream` / `full` / `mixed` | mixed |
| `--concurrency` | `-c` | 并发连接数 | 100 |
| `--requests` | `-n` | 总请求数，0=持续运行 | 0 |
| `--input` | `-i` | 输入文本长度（字符数） | 100 |
| `--interval` | | 统计输出间隔（秒） | 3 |
| `--help` | `-h` | 显示帮助 | |

### 通过测试脚本

```bash
./test.sh [选项]
```

参数与客户端一致：

```bash
./test.sh -c 200 -n 1000 -i 500 --mode stream
./test.sh --host 192.168.1.100 --port 8443 -c 50 -i 2000 --mode full
```

### 预设场景

```bash
./test.sh scenario quick        # 快速验证：50并发, 200请求
./test.sh scenario stream       # 流式压测：100并发, 500请求
./test.sh scenario full         # 非流式压测：100并发, 500请求
./test.sh scenario heavy        # 重压力：500并发, 2000请求
./test.sh scenario long-input   # 长输入：50并发, 2000字符输入
```

### 统计指标

运行时每 3 秒输出一次（可通过 `--interval` 调整）：

```
[14:30:15] 窗口QPS=33.2  全局QPS=33.0  成功=99  失败=0  在途=100  P50=152ms  P90=201ms  P99=312ms
  → 流式: 48次  平均1205ms  0.3MB  TTFT avg=512ms P99=538ms
  → 非流式: 51次  平均45ms  0.2MB
```

| 指标 | 说明 |
|------|------|
| 窗口 QPS | 最近一个统计周期内的每秒完成数 |
| 全局 QPS | 从启动到现在的平均每秒完成数 |
| P50/P90/P99 | 请求延迟百分位 |
| TTFT | 首字延迟（仅流式模式） |
| 在途 | 已发出但尚未完成的请求数 |

`Ctrl+C` 停止时输出最终汇总报告。

## 常见用法

```bash
# 本机快速验证（HTTP 模式）
./deploy.sh start
./test.sh --port 3000 scenario quick
./deploy.sh stop

# 有证书时，HTTPS + HTTP
./deploy.sh start
./test.sh -c 200 -n 1000 -i 500 --mode stream
./deploy.sh stop

# 1000 并发重压测试
./test.sh --port 3000 -c 1000 -n 5000 -i 200 --mode mixed

# 只测流式，关注 TTFT
./test.sh --port 3000 -c 200 -n 1000 --mode stream

# 测试远程服务
./test.sh --host 10.0.0.5 --port 4000 -c 500 -i 500

# 自定义证书和端口启动
CERT_KEY=/etc/ssl/server.key CERT_CERT=/etc/ssl/server.crt HTTPS_PORT=443 ./deploy.sh start

# 持续压测（无限请求，手动 Ctrl+C 停止）
./test.sh --port 3000 -c 200 -i 100
```
