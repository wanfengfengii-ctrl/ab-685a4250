# 病理跨机构标本清单共享服务 (Pathology Manifest Share)

把跨机构标本清单转换为**可共享的脱敏副本**：保留病例、切片及交叉引用
关系，但患者号、送检号、院内记录号绝不以原值进入存储、日志或任何响应。

- 运行时**零 npm 依赖**（仅使用 Node.js 22 内置模块：`http` / `crypto`）
- Docker 构建**完全离线**：唯一的构建工具链（TypeScript + @types/node）
  已 vendor 到 `tools/node_modules` 并提交，镜像构建不访问 npm 源
- 一次性 `verify` 服务在 API 健康检查通过后运行 TypeScript 构建、代码
  测试与提交/查询冒烟，自行退出并以退出码汇总结果

## API

### `POST /api/manifests`

请求：

```json
{
  "batchId": "batch-2026-10-04-A",
  "records": [
    {
      "recordId": "院内记录号",
      "patientId": "患者号",
      "accessionId": "送检号",
      "relatedIds": ["被引用记录的院内记录号"],
      "measurements": { "任意": "JSON测量项", "tumorSizeMm": 11.25 }
    }
  ]
}
```

响应（200）只包含别名与原样测量项：

```json
{
  "batchId": "batch-2026-10-04-A",
  "records": [
    {
      "recordAlias": "REC-94IOI3ACCFT71KJDBQ58A7DGH0",
      "patientAlias": "PAT-G9L1O96MJ0U3C24D5J8BMMH0PC",
      "accessionAlias": "ACC-3FA54R3SL8TS94BII2DUCTLJDS",
      "relatedAliases": ["REC-7V0ESM4FJ32725K5C4O5Q2Q7DK"],
      "measurements": { "任意": "JSON测量项", "tumorSizeMm": 11.25 }
    }
  ]
}
```

行为约定：

| 场景 | 结果 |
| --- | --- |
| 同一类标识出现在任意批次 | 始终得到**相同别名**（HMAC-SHA256，主密钥按部署持久化） |
| 同一原值用于不同类别（患者/送检/记录） | 类别命名空间隔离，别名互不相同、带 `PAT-/ACC-/REC-` 前缀 |
| `relatedIds` 交叉引用 | 一律映射为对应记录的 `REC-` 别名，引用必须闭合 |
| 测量项 | 原值原样保留（仅允许 JSON 安全值） |
| 相同 `batchId` + 相同业务内容重试（含记录乱序） | 返回**原结果**（200，幂等） |
| 相同 `batchId` + 不同业务内容 | `409`，已存结果不被覆盖 |
| 重复 `recordId` / 悬空引用 / 非法结构 / 非法 JSON | `422` 整体拒绝，不写入任何数据 |
| 请求体超过 `MAX_BODY_BYTES` | `413` |

### `GET /api/manifests/{batchId}`

返回已接收的共享副本（与 POST 完全一致）；不存在返回 `404`。
`GET /healthz` 供容器与编排健康检查使用。

## 隐私保证

- 原始三类标识**不入库**：`/data/manifests/*.json` 只含别名、测量项与
  内容 HMAC 摘要（0600 权限，原子写入）。
- **不进日志**：日志只记录结构化事件（事件名、batchId、记录数、问题
  code、下标）；JSON 解析器可能引用请求片段的原生报错被刻意丢弃，绝不
  外发或落盘。
- **不回显**：所有响应只序列化共享副本；422 问题详情只含字段路径与
  code，测试与冒烟对全部响应和日志做原始标识哨兵扫描。
- 别名为**单向**密钥摘要，无法由别名反推院内编号；内容摘要同样使用
  HMAC，防止对低熵院内编号做离线字典攻击。
- 主密钥：设置 `MANIFEST_ALIAS_SECRET` 显式指定；否则首次启动在数据卷
  内生成 0600 持久随机密钥，重启后跨批次别名保持稳定。

## 运行

```sh
# 默认宿主机端口 8080，容器内固定监听 3000
docker compose up --build

# 自定义宿主机端口
API_HOST_PORT=9090 docker compose up --build
```

一次性验证（API 健康后自动执行，退出码 0 表示全部通过）：

```sh
docker compose run --rm verify
```

退出码位掩码：`1` = TypeScript 构建失败，`2` = 代码测试失败，
`4` = 提交/查询冒烟失败。

## 本地开发（无需安装任何依赖）

```sh
node tools/node_modules/typescript/bin/tsc -p tsconfig.json   # 构建
node --test dist/test/*.test.js                               # 测试（先构建）
PORT=3000 MANIFEST_DATA_DIR=./data node dist/src/main.js      # 运行
BASE_URL=http://127.0.0.1:3000 node scripts/smoke.mjs         # 冒烟
```

重新生成 vendor 工具链（需要 npm 源）见 `tools/README.md`。

## 目录结构

```
src/
  config.ts      环境配置（端口/数据目录/密钥/体积上限）
  crypto.ts      类别隔离的 HMAC 别名引擎与内容摘要
  validation.ts  严格结构校验、悬空引用/重复检测、规范化内容哈希
  mapping.ts     原始记录 -> 共享副本（交叉引用同步别名化）
  store.ts       原子持久化（仅别名+摘要）、幂等/冲突判定、密钥管理
  server.ts      零依赖 HTTP 服务（含隐私安全的错误处理与日志边界）
  logger.ts      结构化、隐私安全的可注入日志
test/            node:test 单元 + 端到端测试（含日志/响应泄漏扫描）
scripts/
  smoke.mjs      提交/查询契约冒烟
  verify.mjs     构建 + 测试 + 冒烟聚合入口（verify 服务）
tools/           vendored 离线构建工具链
```
