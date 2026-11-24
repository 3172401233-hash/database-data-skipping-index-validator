# Data Skipping 索引裁剪验证器

验证 zone map（min/max、NULL 计数）驱动的 Data Skipping（数据裁剪）是否正确：
给定区域边界、min-max、NULL 计数、行版本、更新日志和查询谓词，逐个区域判断
能否**安全跳过**，并在索引落后于数据页或统计损坏时输出**过期索引证据**。

## 不连接数据库

本工具是**纯内存模拟**，不连接任何数据库：

- 零第三方依赖，仅使用 Node.js 内置模块（`node:test`、`node:fs` 等）；
- 所有输入来自 JSON 文件 / 内存对象，不读取数据文件、不发起网络请求；
- 数据页的“真实边界”通过输入中的 `pageStats` 字段模拟，用于与索引边界对账。

## 环境要求

- Node.js 24.16.0（`node --version` 确认）；更低版本未验证。

## 快速开始

```bash
node --test                          # 运行全部测试
node src/cli.js scenarios/example.json --pretty
npm run demo                         # 与上一条等价
```

## 项目结构

```
src/
  predicate.js   谓词裁剪推导（等值/范围/IS NULL/否定/AND/OR）
  stale.js       索引过期与损坏证据收集
  engine.js      主入口，组合证据门控与谓词推导
  cli.js         读取 JSON 场景文件并输出报告
scenarios/
  example.json   复现“更新只改数据页、未同步索引导致误裁剪”的场景
test/            node --test 测试套件
```

## 输入格式

```json
{
  "table": "orders",
  "predicate": { "op": "eq", "column": "amount", "value": 250 },
  "changeLog": [
    {
      "zoneId": "z2",
      "operation": "UPDATE",
      "columns": ["amount"],
      "pageVersionBefore": 1,
      "pageVersionAfter": 2
    }
  ],
  "zones": [
    {
      "zoneId": "z2",
      "totalRows": 1000,
      "pageVersion": 2,
      "rowVersion": 2,
      "columns": {
        "amount": {
          "min": 1,
          "max": 99,
          "nullCount": 0,
          "nonNullRows": 1000,
          "indexVersion": 1,
          "corrupted": false
        }
      },
      "pageStats": {
        "amount": { "min": 1, "max": 250 }
      }
    }
  ]
}
```

- `pageVersion`：数据页当前版本；`rowVersion`：区域内最新行版本（默认取页版本）。
- `columns.<col>.indexVersion`：该列 zone map 的版本；缺省时回退到区域级 `zoneMapVersion`。
- `pageStats`：可选，模拟数据页真实 min/max，用于暴露边界漂移。

### 谓词操作符

| 类别 | 操作符 |
| --- | --- |
| 等值 | `eq`、`ne` |
| 范围 | `gt`、`gte`、`lt`、`lte`、`between`（`values: [low, high]`） |
| NULL | `isNull`、`isNotNull` |
| 否定 | `not`（内层包裹任意谓词，含 `and`/`or`，自动按德摩根律转换） |
| 组合 | `and`、`or`（`predicates: [...]`） |

## 裁剪推导规则（索引可信时）

- **等值 `eq`**：字面量落在 `[min, max]` 之外可跳过；`eq NULL` 看 NULL 计数；全 NULL 区域对非 NULL 字面量可跳过。
- **不等 `ne` / 否定等值**：仅当所有非 NULL 行都等于该值且无 NULL 行时才可跳过（NULL 行不满足 `<>`）。
- **范围**：如 `col > v` 在 `max <= v` 时跳过；`between` 与 `[min, max]` 无交集时跳过；边界相等按 SQL 语义保守处理。
- **IS NULL / IS NOT NULL**：分别依据 `nullCount` 与 `nonNullRows` 判断，全 NULL 区域可跳过 `IS NOT NULL`。
- **否定谓词**：`NOT p` 可裁剪当且仅当区域内每一行都满足 `p`（同时要求无 NULL 行，除非 `p` 本身是 NULL 谓词）。
- **AND / OR**：AND 任一子谓词可裁剪即裁剪；OR 需要所有子谓词都可裁剪。
- 任何拿不准的情形（类型不一致、统计缺失、操作符未知）一律**保守读取**。

## 过期索引门控（先于谓词推导）

只要谓词引用列出现以下任一情况，区域立即判定为 `must_read`，不再允许裁剪：

| 证据 kind | 触发条件 |
| --- | --- |
| `missing_stats` | 谓词列没有 zone map 统计 |
| `corrupt_stats` | `corrupted=true`、min/max 倒置或类型不一致、NULL+非NULL 计数之和不等于总行数 |
| `stale_version` | `indexVersion < pageVersion` 或 `indexVersion < rowVersion` |
| `changelog_mismatch` | 更新日志显示该列在当前索引版本之后被更新过 |
| `boundary_drift` | 索引 min/max 与数据页真实 `pageStats` min/max 不一致 |

## 输出格式

- `skippableZones`：可安全跳过的区域 ID 列表；
- `mustReadZones`：必须读取数据页的区域 ID 列表；
- `staleIndexEvidence`：过期/损坏索引的逐条证据（含版本号与中文说明）；
- `zoneDecisions`：每个区域的判定、理由与证据；
- `summary`：计数与过期区域汇总。

## 测试覆盖

`node --test` 共 33 个用例，覆盖：

- 更新导致边界变化后旧索引误裁剪的端到端复现（`scenarios/example.json`）；
- 等值（含字符串、NULL 字面量、类型不一致）；
- 范围谓词的边界等于、BETWEEN 交集、含 NULL 区域；
- IS NULL / IS NOT NULL、全 NULL 与空区域；
- `<>`、`NOT` 包裹（含双重否定、德摩根律）及 NULL 对否定谓词的影响；
- 版本落后、行版本更新、更新日志对账、真实边界漂移；
- 部分索引损坏（损坏标记、min/max 倒置、计数不自洽、统计缺失）；
- AND/OR 组合谓词、输入校验与 CLI 冒烟。
