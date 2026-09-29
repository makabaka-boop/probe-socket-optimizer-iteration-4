# 探针分配 · 最小权完美二分匹配

芯片老化台换批前，把等量探针（行）分配到测试座（列）。部分探针/测试座组合禁配，
不同组合有校准代价。服务端以 **O(n³) 匈牙利算法** 精确求解最小权完美二分匹配，
页面支持编辑代价矩阵、查看方案、排除单个配对后重算替代最优。
同一次求解还会做**必然连线分析**：标出每条展示配对是否出现在所有同价最优方案中，
并给出该探针的可替换连线数（O(n²) 等势子图强连通分析，不枚举排列）。

## 目录结构

```
server/
  hungarian.js    # O(n³) 最小权完美二分匹配（匈牙利算法，禁配边=Infinity）
  mandatory.js    # 必然连线分析：等势子图 + 强连通分量，输出 forced/alternatives
  validation.js   # 输入校验（n、维度、整数范围）
  server.js       # Fastify：POST /api/solve + 生产环境静态托管
src/
  App.jsx                  # 页面：编辑、请求锁定、方案展示、排除重算、本地复算、必然/可替换高亮
  validateSolution.js      # 成功响应校验：n 身份、assignment 排列、禁配格、totalCost 复算、pairFlags 完整对应
  components/MatrixGrid.jsx  # 虚拟化 n×n 矩阵（n=400 流畅）
test/
  hungarian.test.js  # 随机小矩阵 n! 穷举核对 + Hall 无解 + 大数精度
  mandatory.test.js  # 独立穷举最优集合预言机：唯一最优/同价多解/禁配/断开图/零价/重复代价
  api.test.js        # HTTP：200/409/422 + pairFlags 同次返回 + n=400 三秒性能
  app.test.jsx       # 页面：锁定编辑、编辑清旧方案、排除重算、标记同次更新/失败清除
  validateSolution.test.js     # 响应校验纯函数：短数组/重复列/越界列/禁配/费用/n 不符/畸形标记
  responseValidation.test.jsx  # 页面级伪造畸形成功响应：稳定协议错误、结果清理、矩阵零误标、旧版兼容
verify/
  wait-http.mjs      # verify 容器等待 web 健康
Dockerfile           # web：Vite 构建 → Fastify 托管
Dockerfile.verify    # verify：Vitest 端到端验收镜像
docker-compose.yml
```

## 快速开始（Docker Compose）

```bash
# 通过 WEB_PORT 指定宿主机发布端口（默认 8080）
WEB_PORT=8080 docker compose up --build web
# 浏览器打开 http://localhost:8080
```

验收服务（对已启动的 web 容器发真实 HTTP 请求跑全部测试）：

```bash
docker compose up -d web
docker compose run --rm verify
```

verify 容器会等待 `http://web:3000/api/health` 就绪，再以
`TARGET_BASE_URL=http://web:3000` 运行 Vitest；API 测试自动切换为真实 HTTP 模式，
包含随机小矩阵穷举核对、Hall 无解矩阵、n=400 稠密矩阵 3 秒内精确返回。

## 本地开发

```bash
npm ci
npm run dev        # Vite 5173，/api 代理到 Fastify 3000
npm start          # 另一个终端启动 Fastify
npm test           # Vitest 全量测试
npm run build      # 产出 dist/，由 Fastify 生产托管
```

## 接口

`POST /api/solve`

请求：`{ "costs": number[][] }`

- n = costs.length，1 ≤ n ≤ 400，必须为 n×n 方阵
- 元素只能是 `null`（禁配）或 `0..1_000_000_000_000` 的整数
- 行=探针，列=测试座

成功 `200`：

```json
{
  "status": "ok",
  "n": 4,
  "assignment": [3, 0, 1, 2],
  "totalCost": 205,
  "pairFlags": [
    { "forced": true, "alternatives": 0 },
    { "forced": true, "alternatives": 0 },
    { "forced": true, "alternatives": 0 },
    { "forced": true, "alternatives": 0 }
  ]
}
```

`assignment[i]` 为第 i 行探针匹配的列（0 基），是一个 0..n−1 的排列，
覆盖全部行与列；`totalCost` 为精确整数总和，可用配对对原矩阵直接复算。
存在多个最优解时任选其一。

`pairFlags[i]` 与 `assignment` 逐行对齐，**只针对本次实际展示的这组配对**：

- `forced`（稳定布尔）：`true` = 该连线出现在**每一个**同价最优完美匹配中（必然连线）；
  `false` = 存在另一个最优方案把该探针改配（可替换）。
- `alternatives`：该探针在最优解集合里还能改配的**其他列数量**；必然时恒为 0，
  与 `forced` 互为充分必要（`forced === (alternatives === 0)`）。

标记与方案、总价在**同一次响应**中给出；分析不改变求解器给出的配对与价格，
求解器仍可返回任一最优解。`409`/`422` 失败响应不携带方案，也不携带任何标记。

失败：

- `422 { "error": "INVALID_INPUT" }`：缺行、错维度、越界、非整数、JSON 非法等
- `409 { "error": "NO_PERFECT_ASSIGNMENT" }`：禁配关系下不存在完美匹配（违反 Hall 条件）

两类失败响应都不携带方案，页面会清除旧方案。

## 算法说明

标准 Hungarian（Kuhn–Munkres）势函数增广：维护行势 `u`、列势 `v` 与当前匹配 `p`，
每轮把一个新行挂到虚拟列 0，沿等势交错树用松弛 `a[i][j]-u[i]-v[j]` 扩展，
取最小 delta 平移势函数直到到达自由列，再回溯翻转增广。共 n 轮，每轮 O(n²)，
总计 **O(n³)**，不枚举任何排列。

- 禁配边以 `Infinity` 存储（`Float64Array.fill(Infinity)`），不参与松弛；
  若最小 delta 为 Infinity，说明自由列在允许子图中不可达（Hall 条件被破坏），
  立即返回无完美匹配。
- 代价最大 1e12、n 最大 400，总代价上界 4e14，小于 2^53，全程整数精确；
  总和直接对输入整数矩阵求和复算，不依赖势函数中间值。

### 必然连线分析（等势子图 + 强连通分量，O(n²)）

求解结束后复用终态势函数 `u/v`（满足允许边 `a[i][j]-u[i]-v[j] >= 0`，配对边上恰为 0）：

1. **等势（紧边）子图**：所有松弛恰为 0 的允许边。一个完美匹配最优，当且仅当它全部由紧边组成。
   禁配边（Infinity/null）永不紧；零价与重复代价天然落在紧边上，无需特殊处理。
2. 构造有向**交错图**：配对边画 `列 j → 行 i`，非配对紧边画 `行 i → 列 j`。
3. 展示配对 `(i,j)` 能被某个同价最优方案替换，当且仅当图上存在经过它的有向环，
   即行节点 i 与列节点 j 属于同一个强连通分量（迭代式 Tarjan）。不在同一 SCC
   ⇒ 该边被每一个最优完美匹配共用 ⇒ `forced=true`。
4. `alternatives` = 与行 i 同 SCC 内、由 i 出发的非配对紧边数（环上 i 可直接改配的不同列）。

断开图（如两个互不相干的紧边块）之间不会出现可替换；SCC 天然把这种边界算对。
接口只暴露稳定布尔与可替换数量，不返回势函数、邻接表、SCC 编号等内部中间态。

## 页面交互约定

- 请求进行中：矩阵格、规模、预设、提交按钮全部禁用（锁定编辑与提交）。
- 请求结束后任何编辑（改格、改尺寸、预设）立即清除旧方案、错误与必然标记。
- 成功响应上屏前逐条校验（防代理/缓存/滚动升级中的旧服务返回脏数据）：
  响应 `n` 必须等于当前矩阵规模；`assignment` 必须是长度 n、列不重复、
  不越界、不命中禁配格的合法排列；`totalCost` 必须是非负安全整数且与
  按当前矩阵逐项复算的总价精确相等；`pairFlags` 字段一旦存在，必须是长度 n
  且每项 `{ forced: boolean, alternatives: 0..n-1 }` 并满足
  `forced ⇔ alternatives===0`。任何一项不符都按 `PROTOCOL_ERROR` 处理：
  清除旧方案与旧高亮、不允许继续排除，绝不展示无法复算的“方案”。
  完全缺少 `pairFlags` 的旧版合法响应仍展示分配与总价，仅不显示分析标记。
- 每个配对可点“排除此配对”：该格被置为禁配（✕），经同一 `/api/solve` 重算，
  展示替代最优方案**并对新展示配对重新分析**（不沿用排除前的标记）；
  若替代问题无解则显示 409 并清除旧方案与标记。
- 方案区对返回配对独立复算总代价并与服务端数值比对。
- 配对卡片与矩阵格按标记高亮：绿色实边=必然连线，琥珀虚边=可替换；
  下方图例解释含义并汇总必然/可替换条数，悬停可见说明。
