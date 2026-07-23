# AI 赛事叙事架构

## 范围

AI 项目只实现 `narrative.generate`：把已结算赛事的最小化摘要转换为可展示的战报。赛果、随机种子、奖励、成就、货币、库存、价格和订单必须先在权威服务中完成，AI 的任何结果都不能回写或影响它们。

## 目录总览

```text
apps/ai/
├── src/
│   ├── application/       # 用例编排、重试与预算决策
│   │   ├── ports/         # 对外依赖的抽象接口
│   │   └── use-cases/     # 生成、回退与任务处理用例
│   ├── config/            # 仅服务器可读的运行配置模型
│   ├── domain/            # 叙事领域模型、输入/输出契约与策略
│   │   ├── narrative/     # 叙事值对象和结果状态
│   │   └── policy/        # 输入最小化、内容、语言与配额规则
│   ├── infrastructure/    # OpenAI、SQLite、日志等适配器
│   │   ├── observability/ # 审计、指标与脱敏日志适配器
│   │   ├── openai/        # 无工具 Responses API 适配器
│   │   └── persistence/   # SQLite 任务、结果和记录仓储适配器
│   ├── shared/            # 无业务含义的通用小工具
│   └── worker/            # 受控的单进程任务循环与任务装配
└── tests/                 # 与源码层级对应的测试资产
```

当前 `src/index.ts` 与 `src/schema.ts` 是已有的过渡入口和输出 Schema；后续演进时应逐步迁移到上述边界，避免新增跨层依赖。

## 依赖方向

```text
worker → application → domain
infrastructure → application ports → domain
config → infrastructure / worker（只提供已解析配置）
shared ← 所有层（不得反向依赖业务层）
```

`domain` 不得依赖 OpenAI SDK、Fastify、Drizzle、SQLite、HTTP 或环境变量。`application` 只依赖领域模型和端口。`infrastructure` 是唯一接触 Responses API、SQLite 实现与日志 SDK 的层。

## 任务与降级流

1. 权威赛事结算完成后，以 `tournamentId + narrativeVersion` 写入唯一的 `narrative.generate` 任务。
2. `worker` 串行领取任务，并由 `application` 组装允许字段的摘要；未结算数据与敏感数据一律拒绝。
3. `infrastructure/openai` 使用 Structured Outputs 发起无工具调用。
4. `domain/policy` 校验 Schema、字段长度、语言、敏感内容和赛事标识。
5. 合格结果或模板结果被持久化为可展示战报；审计记录模型、摘要哈希、延迟、令牌、成本和失败原因。

同一任务的成功、失败和重试不得重新结算赛事，也不得改变任何经济状态。

## 数据与访问边界

| 数据 | AI 项目可做 | AI 项目禁止做 |
| --- | --- | --- |
| 已结算赛事摘要 | 最小化读取、生成叙事 | 修改赛果或读取未结算信息 |
| 叙事任务/结果/审计 | 经仓储端口创建、领取、记录 | 任意业务表直写或删除审计 |
| OpenAI 配置与密钥 | 仅服务器运行时读取 | 返回给调用方或浏览器 |
| 经济与账户数据 | 不读取、不写入 | 计算或决定任何结算 |
