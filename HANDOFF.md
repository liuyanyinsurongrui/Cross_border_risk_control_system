# 项目交接文档 - 跨境电商独立站链接违规审核系统

> 本文档供后续开发者（如 Codex）快速理解项目全貌、当前实现状态、已知问题和优化方向。

---

## 一、项目概述

AI 驱动的跨境电商独立站产品链接违规审核 Web 应用。用户批量导入产品链接 → 自动抓取网页内容（文字+图片）→ AI 合规审核 → 结果推送飞书多维表格。

### 技术栈
- **框架**: Next.js 16 (App Router) + React 19 + TypeScript 5
- **UI**: shadcn/ui (Radix UI) + Tailwind CSS 4
- **HTML 解析**: cheerio（抓取网页时解析 DOM）
- **AI/LLM**: coze-coding-dev-sdk 的 LLMClient（流式调用，支持多模型切换）
- **Excel 解析**: xlsx
- **图标**: lucide-react
- **包管理器**: pnpm（严禁 npm/yarn）

### 运行环境
- 工作目录: `${COZE_WORKSPACE_PATH}` (默认 `/workspace/projects/`)
- 端口: 5000（唯一合法端口）
- 启动命令: `pnpm dev`
- 构建: `pnpm build` / 类型检查: `pnpm ts-check` / Lint: `pnpm lint`

---

## 二、目录结构与核心文件

```
src/
├── app/
│   ├── api/
│   │   ├── upload/route.ts          # Excel上传与解析，识别链接列
│   │   ├── fetch/route.ts           # 网页抓取（707行，最复杂文件）⭐
│   │   ├── audit/route.ts           # AI审核（283行）⭐
│   │   └── feishu/
│   │       ├── route.ts             # 飞书多维表格推送
│   │       └── create-bitable/route.ts  # 创建飞书多维表格
│   ├── layout.tsx
│   ├── page.tsx                     # 主页面，三栏布局+状态管理（370行）
│   └── globals.css
├── components/
│   └── audit/
│       ├── upload-zone.tsx          # Excel上传拖拽区
│       ├── link-list.tsx            # 链接列表
│       ├── content-preview.tsx      # 抓取内容预览（分Tab展示素材图/详情图）
│       ├── result-panel.tsx         # 审核结果面板（含各规则详情）
│       ├── rules-config.tsx         # 审核规则配置弹窗（569行）⭐
│       ├── feishu-config-dialog.tsx # 飞书配置弹窗
│       ├── stats-bar.tsx            # 统计栏
│       └── ...
├── hooks/
│   ├── use-toast.ts
│   └── use-mobile.ts
└── lib/
    ├── types.ts                     # 共享类型定义（114行）
    └── utils.ts
```

---

## 三、核心 API 路由详解

### 1. POST /api/fetch — 网页抓取（最复杂，707行）

**当前实现**: 原生 `fetch` + `cheerio` 解析 HTML，零 token 消耗。

**文字提取策略（按优先级）**:
1. 嵌入的 `productJson`（从 HTML 的 `<script>` 标签中解析 `"product":{...}` JSON 对象）
   - 提取字段：`post_content` → `body_html` → `body` → `content` → `detail` → `description`
   - `htmlToText()` 清理 HTML 标签转为纯文本
2. DOM 选择器定位描述区域（`.product-description`, `.rte`, `#product-description` 等）
3. JSON 正则兜底提取

**文字提取核心逻辑**: 
- 优先从 `productJson` 取描述 → DOM 选择器补充 → 正则兜底
- `filterTemplateNoise()` 过滤 Shopify 模板噪声（"Subscribe to our newsletter", "About Us", "Contact Us" 等）
- 最终截断 8000 字符

**图片提取策略 — 双分类**:
- **商品素材图** (`productImages`): 来自 gallery/medias/feature_image/variants
- **商品详情图** (`detailImages`): 来自 content/body_html/post_content HTML 中的 `<img>` 标签
- 两类图片各自独立去重（`seenProductUrls` / `seenDetailUrls`），互不交叉去重

**图片提取步骤**:
1. productJson 中的 gallery/medias → 素材图
2. productJson 中的 content/body_html → 详情图
3. HTML gallery JSON 数组 → 素材图
4. HTML "content" 字段（unicode 转义 `\u003C`）→ 详情图
5. cheerio 从描述区域 DOM → 详情图
6. cheerio 从商品图库区域 DOM → 素材图（仅 JSON 没提供时）
7. JSON-LD 结构化数据 → 图片
8. 最后兜底：从全页面 `<img>` 提取

**噪声过滤**: `.gif`、`assets/`路径、favicon、logo、icon、payment、社交图标等

**关键函数**:
- `extractProductJson(html)`: 从 HTML 提取嵌入的产品 JSON 数据
- `normalizeImageUrl(imgUrl, baseUrl)`: 相对路径转绝对、去尺寸后缀、噪声过滤
- `isNonProductImage(url)`: 判断是否为非产品图片
- `extractImagesFromHtml(htmlFragment, baseUrl, maxImages)`: 从 HTML 片段提取图片 URL
- `htmlToText(html)`: cheerio 清理 HTML 转纯文本
- `filterTemplateNoise(text)`: 过滤 Shopify 模板默认文本

---

### 2. POST /api/audit — AI 审核（283行）

**当前实现**: 使用 `coze-coding-dev-sdk` 的 `LLMClient` 流式调用 AI 模型。

**审核流程**:
1. 接收 `{ content: ScrapedContent, rules: AuditRules }`
2. 过滤出 `enabled=true` 的规则
3. 如果没有启用规则 → 直接返回 `{conclusion: "未审核"}`，**不调用任何模型**
4. 每条启用规则独立审核（并发控制：最多 2 条规则同时）
5. 每条规则调用 `auditWithRule(content, rulePrompt, model, request)`
6. 聚合所有规则结果

**`auditWithRule` 函数**:
- 只传 `rule.prompt` 作为审核指令，**不传 `rule.name`**（标题仅展示用）
- 构建消息：系统提示词（`BASE_SYSTEM_PROMPT`）+ 用户消息（标题+URL+文字+审核指令+最多5张图片）
- 使用规则指定的 `model` 参数调用 `client.stream()`
- 解析 AI 返回的 JSON，标准化 conclusion 为 "合规"/"违规"/"待人工复核"

**结果聚合** (`aggregateResults`):
- 任一规则违规 → 整体违规
- 全部合规 → 整体合规
- 其余 → 待人工复核

**可用模型**（11个）:
```
doubao-seed-2-0-pro-260215, doubao-seed-2-0-lite-260215, doubao-seed-2-0-mini-260215,
doubao-seed-1-8-251228, kimi-k2-5-260127, qwen-3-5-plus-260215,
deepseek-v3-2-251201, glm-5-0-260211, glm-4-7-251222,
minimax-m2-5-260212, minimax-m2-7-260318
```

---

### 3. POST /api/upload — Excel 上传

- 接收 FormData，用 `xlsx` 库解析
- 自动识别链接列（查找含 http 的列）
- 返回 `{ links, detectedColumns, totalRows, validLinks }`

### 4. POST /api/feishu — 飞书推送

- 接收 `{ config: FeishuConfig, results: AuditResult[] }`
- 推送到飞书多维表格
- 字段包括：链接、标题、审核结论、违规详情、商品素材图链接、商品详情图链接等

---

## 四、核心类型定义 (src/lib/types.ts)

```typescript
// 审核状态
type AuditStatus = 'pending' | 'scraping' | 'auditing' | 'passed' | 'violated' | 'error' | 'review';

// 抓取内容
interface ScrapedContent {
  title: string;
  textContent: string;
  productImages: ScrapedImage[];  // 商品素材图
  detailImages: ScrapedImage[];   // 商品详情图
  images: ScrapedImage[];         // @deprecated 向后兼容
  url: string;
}

// 审核规则
interface AuditRule {
  id: string;
  name: string;       // 仅展示用，不参与 AI 审核提示词
  prompt: string;     // AI 审核时的检查指令（核心内容）
  enabled: boolean;
  model: string;      // 使用的模型 ID
}

// 审核结果
interface AuditResult {
  id: string;
  productLink: ProductLink;
  conclusion: '合规' | '违规' | '待人工复核';
  violations: ViolationItem[];
  analysis: string;
  ruleResults?: RuleAuditResult[];  // 每条规则的独立审核结果
  status: AuditStatus;
  scrapedContent?: ScrapedContent;
}
```

---

## 五、主页面流程 (page.tsx)

1. 上传 Excel → 解析链接列表 → 显示在左栏
2. 点击"一键审核" → 并发抓取+审核（3 worker pool）
   - 先调用 `/api/fetch` 抓取内容
   - 再调用 `/api/audit` 审核
3. 中栏显示抓取内容预览（文字 + 素材图/详情图分 Tab）
4. 右栏显示审核结果（结论 + 各规则详情）
5. 可推送到飞书多维表格

**三栏布局**: 4/4/4 等宽（左：数据导入 / 中：内容预览 / 右：审核结果）

---

## 六、已知问题与卡点

### 卡点1: 文字提取仍然不够精准（中等优先级）

**现状**: 对于有 `productJson` 的网站（大多数 Shopify 站），文字提取效果已经很好。但对于没有嵌入 JSON 数据的网站，DOM 选择器可能定位不准。

**具体问题**:
- 某些网站的描述区域 class/id 不在预设选择器列表中
- 部分网站的产品描述在 JavaScript 渲染后才可见（SPA），原生 fetch 只能拿到空壳 HTML
- `filterTemplateNoise()` 的噪声列表可能不完整，某些模板文本仍会混入

**优化方向**:
- 扩充描述区域选择器列表
- 增加更多模板噪声过滤规则
- 考虑对 SPA 网站增加无头浏览器抓取（如 Playwright），但这会大幅增加复杂度

### 卡点2: 图片提取在某些网站仍有遗漏（低优先级）

**现状**: 大部分网站效果良好（conditionstatus/usualous/previousin/gogodusk 均测试通过），但个别网站可能因为：
- 图片使用 CSS `background-image` 而非 `<img>` 标签
- 图片使用懒加载（data-src 等自定义属性名不在预设列表中）
- 图片 URL 使用 CDN 签名参数导致同一张图被当作不同图片

**优化方向**:
- 扩充 `imgAttrPatterns` 列表
- 增加对 `<picture>` / `<source>` 元素的解析
- 对 CDN URL 去签名后比较

### 卡点3: `stats-bar.tsx` 缺少"未审核"状态统计（低优先级）

**现状**: `stats-bar.tsx` 目前只有 总计/待审核/合规/违规/待复核/处理中/错误 这些统计项，没有"未审核"（所有规则关闭时的结论）。

**影响**: 功能上不影响使用，"未审核"的项目会归入"待审核"统计。

**修复**: 在 `stats-bar.tsx` 中增加 `unaudited` 统计，或在逻辑上将"未审核"归入"待审核"。

### 卡点4: 审核 AI 返回格式不稳定（中等优先级）

**现状**: AI 有时不严格按 JSON 格式返回，可能包含 markdown 代码块包裹或其他格式。

**当前处理**: 
- 正则提取 `` ```json ... ``` `` 中的 JSON
- 解析失败时降级为"待人工复核"

**优化方向**:
- 在系统提示词中更强调 JSON 输出格式
- 增加重试机制（格式不对时重新调用）
- 增加更鲁棒的 JSON 提取逻辑

### 卡点5: 飞书推送偶尔报错（低优先级）

**日志中可见错误**:
- `The last table cannot be deleted.` — 飞书 API 限制不能删除最后一张表
- `创建数据表失败: success` — 错误信息矛盾，可能是飞书 API 的 bug

**影响**: 不影响核心审核功能，但推送可能偶尔失败。

---

## 七、重要设计决策（变更历史）

1. **FetchClient SDK → 原生 fetch + cheerio**: 用户反馈 SDK 抓取消耗 token，且文字/图片提取不准确。已改为纯代码实现，零 token 消耗。
2. **硬编码6大审核维度 → 用户自定义规则**: 用户反馈审核维度应该是可配置的提示词，不是硬编码。已改为每条规则独立的 prompt + model。
3. **规则标题参与提示词 → 不参与**: 用户反馈规则名只是标题，不应影响 AI 审核。已改为只传 prompt 内容。
4. **规则关闭仍调用模型 → 不调用**: 用户反馈关闭的规则不应消耗模型资源。已改为关闭规则直接跳过。
5. **图片交叉去重 → 独立去重**: 用户反馈详情图被素材图去重导致丢失。已改为两类图片各自内部去重。
6. **规则配置在左侧栏 → 独立弹窗**: 用户反馈左侧栏太拥挤。已改为 Dialog 弹窗。
7. **Method1 匹配无验证 → 增加验证**: previousin.com 的 Method1 匹配到布局模板而非产品数据。已增加 gallery/price/sku/variants 验证。

---

## 八、测试验证数据

以下 URL 已通过测试验证：

| 网站 | 文字提取 | 素材图 | 详情图 | 耗时 |
|------|---------|--------|--------|------|
| conditionstatus.com | ✅ 精准（无模板噪声） | ✅ | ✅ | ~2s |
| usualous.com | ✅ 产品特性描述 | ✅ | ✅ | ~1.1s |
| previousin.com | ✅ 产品使用说明 | ✅ | ✅ | ~1.2s |
| gogodusk.com | ✅ 产品描述 | ✅ | ✅ | ~1.5s |

---

## 九、开发规范速查

- TypeScript strict 模式，禁止隐式 any
- 后端 API 路由必须使用 `HeaderUtils.extractForwardHeaders(request.headers)` 提取请求头
- 前端组件使用 `'use client'`，动态内容用 `useEffect` + `useState` 避免 hydration 错误
- 仅使用 pnpm
- 代码中不要硬编码端口（使用 `process.env.DEPLOY_RUN_PORT`）
- 生成文件优先存对象存储，本地可写目录：开发环境 `public/`，生产环境 `/tmp`
