# 部署架构文档

本文档用于说明本项目作为“模型推理模拟服务”时的部署方式，以及它在整条调用链中对 `ModelArts` 推理链路的替代关系。

## 1. 目标

当前需要通过以下链路模拟真实生产访问路径：

`ELB -> APIG -> VPCEP Client -> VPCEP Server -> ECS`

这条模拟链路用于替代真实目标链路：

`ELB -> APIG -> ModelArts`

而 `ModelArts` 内部实际可进一步拆解为：

`VPCEP Client -> VPCEP Server -> Dispatcher -> NPU Pod`

因此，本项目在当前阶段承担的是“用 ECS 上的模拟推理服务，代替 ModelArts 内部推理后端”的角色。

## 2. 替换关系总览

```text
现网目标链路
┌─────┐   ┌──────┐   ┌──────────────────────────────────────────────────┐
│ ELB │-->| APIG │-->|                ModelArts 服务域                  │
└─────┘   └──────┘   │  ┌──────────────┐  ┌──────────────┐  ┌──────────┐ │
                      │  │ VPCEP Client │->│ VPCEP Server │->│Dispatcher│ │
                      │  └──────────────┘  └──────────────┘  └────┬─────┘ │
                      │                                            │       │
                      │                                       ┌────▼────┐  │
                      │                                       │ NPU Pod  │  │
                      │                                       └─────────┘  │
                      └──────────────────────────────────────────────────┘

当前模拟链路
┌─────┐   ┌──────┐   ┌──────────────┐   ┌──────────────┐   ┌───────────────┐
│ ELB │-->| APIG │-->| VPCEP Client │-->| VPCEP Server │-->| ECS 模拟服务   │
└─────┘   └──────┘   └──────────────┘   └──────────────┘   │ pressure_server│
                                                            └───────────────┘

替换逻辑
┌───────────────────────────────────────────────────────────────────────────┐
│ 对外保持：ELB -> APIG 的入口形态不变                                     │
│ 对内替换：ModelArts 整体推理域  ==>  VPCEP Server 后挂 ECS 模拟服务      │
│ 替代范围：VPCEP Server 之后的 Dispatcher + NPU Pod 推理执行能力          │
└───────────────────────────────────────────────────────────────────────────┘
```

## 3. 组件职责

### 3.1 ELB

- 作为北向统一入口，承接调用流量。
- 向 `APIG` 转发请求。
- 可用于模拟公网或上层业务访问入口。

### 3.2 APIG

- 提供统一 API 发布能力。
- 负责路由转发、认证鉴权、流控、灰度等网关能力。
- 将请求转发到后端私网访问链路。

### 3.3 VPCEP Client

- 代表私网访问链路的客户端侧入口。
- 将 `APIG` 的后端访问引入 VPCEP 通道。
- 在模拟方案中，该层保持不变，用来复现真实访问路径。

### 3.4 VPCEP Server

- 代表 VPCEP 服务端落点。
- 在真实方案中，其后方对接 `ModelArts` 推理服务域。
- 在当前模拟方案中，其后方改为对接 `ECS` 上部署的本项目服务。

### 3.5 ECS 模拟服务

- 在 ECS 上部署本仓库服务，模拟大模型推理接口行为。
- 对外暴露与测试目标一致的 HTTP/HTTPS API。
- 模拟两类典型推理行为：
  - 流式输出：`/deepseek-r1-tx/v1/chat`
  - 非流式输出：`/deepseek-r1-tx/v1/chat/completions`
- 可配置并发、延迟、响应长度，用于压测和链路验证。

### 3.6 ModelArts 内部链路（真实目标）

真实 `ModelArts` 链路可抽象为：

`VPCEP Client -> VPCEP Server -> Dispatcher -> NPU Pod`

其中：

- `Dispatcher` 负责请求调度、实例选择、转发控制。
- `NPU Pod` 负责真实模型推理执行。

本项目当前并不模拟 `Dispatcher` 和 `NPU Pod` 的内部控制面细节，而是从接口行为和时延特征上进行替代。

## 4. 部署边界说明

建议按以下边界理解当前部署：

```text
北向入口域
  ELB
   |
  APIG

私网接入域
  VPCEP Client
   |
  VPCEP Server

模拟推理域
  ECS
   └── pressure_server_cluster.js
```

对应替换关系为：

- `ELB`、`APIG`、`VPCEP Client`、`VPCEP Server` 保持真实形态或按真实方式部署。
- `ModelArts` 推理域临时替换为 `ECS 模拟推理域`。
- 从链路视角看，请求仍然经过完整前置接入层，只是最终落点从 `ModelArts` 变成了 `ECS`。

## 5. 推荐部署方案

### 5.1 ECS 侧部署

在一台或多台 ECS 上部署本项目服务：

```bash
./deploy.sh start
```

默认行为：

- 无证书时：监听 `HTTP :3000`
- 有证书时：监听 `HTTPS :4000`，并由 `HTTP :3000` 跳转到 `HTTPS`

建议：

- 若 VPCEP Server 后端需要 HTTPS，给 ECS 服务配置证书并启用 `4000`。
- 若仅用于内网链路压测，可直接使用 HTTP 模式。
- 若需要更高吞吐，优先使用 `pressure_server_cluster.js` 多 Worker 模式。

### 5.2 APIG 与 VPCEP 配置建议

后端配置建议如下：

- `APIG` 后端地址指向 `VPCEP Client`
- `VPCEP Client` 通过私网 endpoint 访问 `VPCEP Server`
- `VPCEP Server` 后端地址指向 ECS 模拟服务
- 后端路径透传到本项目 API 路径

建议透传以下两个接口路径：

- `/deepseek-r1-tx/v1/chat`
- `/deepseek-r1-tx/v1/chat/completions`

### 5.3 与真实 ModelArts 对应关系

部署映射可理解为：

| 真实目标 | 当前模拟替代 |
|----------|--------------|
| ModelArts 服务入口 | VPCEP Server 后挂 ECS 模拟服务 |
| Dispatcher | 由 ECS 模拟服务直接吸收，不单独拆层 |
| NPU Pod 推理执行 | 由 ECS 模拟服务返回模拟结果 |
| 模型真实耗时 | 由 TTFT / TPOT 等延迟参数模拟 |

## 6. ASCII 部署图

下面这幅图可直接放入方案文档或汇报材料中：

```text
                    当前模拟方案

          +------+      +------+      +---------------+
Client -->| ELB  |----->| APIG |----->| VPCEP Client  |
          +------+      +------+      +-------+-------+
                                                 |
                                                 v
                                          +------+-------+
                                          | VPCEP Server |
                                          +------+-------+
                                                 |
                                                 v
                                          +------+----------------------+
                                          | ECS                         |
                                          | LLM Pressure Test Service   |
                                          | pressure_server_cluster.js  |
                                          +-----------------------------+


                    真实目标方案

          +------+      +------+      +-------------------------------+
Client -->| ELB  |----->| APIG |----->| ModelArts                     |
          +------+      +------+      |                               |
                                       |  +-------------+              |
                                       |  | VPCEP Client|              |
                                       |  +------+------+              |
                                       |         |                     |
                                       |         v                     |
                                       |  +------+------+              |
                                       |  | VPCEP Server|              |
                                       |  +------+------+              |
                                       |         |                     |
                                       |         v                     |
                                       |  +------+------+              |
                                       |  | Dispatcher |              |
                                       |  +------+------+              |
                                       |         |                     |
                                       |         v                     |
                                       |    +----+----+               |
                                       |    | NPU Pod |               |
                                       |    +---------+               |
                                       +-------------------------------+


                    替换逻辑

          ELB -> APIG -> ModelArts
                     ||
                     || 拆开后识别为
                     \/
          ELB -> APIG -> VPCEP Client -> VPCEP Server -> Dispatcher -> NPU Pod
                     ||
                     || 当前以模拟服务替代 VPCEP Server 后面的真实推理执行域
                     \/
          ELB -> APIG -> VPCEP Client -> VPCEP Server -> ECS(pressure_server)
```

## 7. 本项目在链路模拟中的价值

本项目适合承担以下验证任务：

- 验证 `ELB -> APIG -> VPCEP` 整条链路的连通性
- 验证 APIG 对流式和非流式接口的转发兼容性
- 验证 VPCEP 场景下的私网访问路径是否正确
- 在未接入真实 `ModelArts`/`NPU Pod` 前，提前开展压测
- 模拟不同响应长度、TTFT、TPOT，以观察上层系统表现

不适合承担的内容：

- 真实模型精度验证
- Dispatcher 调度策略验证
- NPU 资源利用率验证
- ModelArts 内部控制面故障定位

## 8. 接口与端口建议

### 8.1 服务接口

本项目默认提供以下接口：

| 路径 | 方法 | 用途 |
|------|------|------|
| `/deepseek-r1-tx/v1/chat` | `POST` | 流式 SSE 模拟 |
| `/deepseek-r1-tx/v1/chat/completions` | `POST` | 非流式 JSON 模拟 |

### 8.2 服务端口

| 端口 | 说明 |
|------|------|
| `3000` | HTTP 服务端口，或 HTTPS 场景下的跳转端口 |
| `4000` | HTTPS 服务端口 |

若需适配现网规范，可通过环境变量调整：

```bash
HTTP_PORT=8080 HTTPS_PORT=8443 ./deploy.sh start
```

## 9. 验证建议

建议分三层验证：

### 9.1 ECS 本地验证

先直接访问 ECS 服务，确认模拟服务本身可用：

```bash
./deploy.sh start
./test.sh --host 127.0.0.1 --port 3000 scenario quick
```

### 9.2 VPCEP 链路验证

将测试流量打到 `VPCEP Server` 后端地址，验证私网链路联通。

### 9.3 全链路验证

最终从 `ELB` 或 `APIG` 暴露地址发起请求，验证：

- 路由是否正确
- SSE 是否被中间层缓冲或截断
- 非流式响应是否正常透传
- 时延是否符合预期

## 10. 结论

当前方案的核心思路是：

- 前半段保留真实接入链路：`ELB -> APIG -> VPCEP Client -> VPCEP Server`
- 后半段用 ECS 模拟服务替代真实 `ModelArts` 推理执行域
- 从而在未接入真实 `Dispatcher/NPU Pod` 的情况下，提前完成链路联调、协议验证和压力测试

如果后续需要，我可以继续把这份文档扩成更正式的版本，例如补充：

- 分层网络拓扑图
- 安全组 / 子网 / 端口矩阵
- APIG 后端配置示例
- VPCEP 对接说明
- 切换到真实 ModelArts 的迁移步骤
