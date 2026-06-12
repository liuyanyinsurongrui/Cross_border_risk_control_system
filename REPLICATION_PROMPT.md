# 跨境电商独立站链接违规审核系统 - 完整复刻提示词

## 项目概述

开发一款AI驱动的跨境电商独立站产品链接违规审核Web应用。支持单条/批量导入产品链接、自动抓取网页内容（文字+图片，含SPA网站和AVIF格式）、智能合规审核、审核结果一键推送飞书多维表格（含自动创建表格和字段）。

## 技术栈

- Next.js 16 (App Router, src目录)
- React 19
- TypeScript 5 (strict模式)
- shadcn/ui (Radix UI) + Tailwind CSS 4
- coze-coding-dev-sdk (LLMClient + FetchClient + S3Storage) — 后端专用，禁止自建替代
- xlsx — Excel解析
- lucide-react — 图标
- 仅使用 pnpm 管理依赖

## 目录结构

```
src/
├── app/
│   ├── api/
│   │   ├── upload/route.ts          # POST Excel上传解析
│   │   ├── fetch/route.ts           # POST 网页内容抓取(FetchClient + 降级fetch)
│   │   ├── audit/route.ts           # POST AI合规审核(LLMClient多模态)
│   │   └── feishu/
│   │       ├── route.ts             # POST 审核结果推送飞书多维表格
│   │       └── create-bitable/route.ts # POST 一键创建飞书多维表格+字段
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx                     # 主页面(初始居中上传 / 三栏布局)
├── components/
│   ├── audit/
│   │   ├── upload-zone.tsx          # 数据导入(单条链接+Excel批量)
│   │   ├── link-list.tsx            # 链接列表(状态图标)
│   │   ├── content-preview.tsx      # 抓取内容预览(标题+文字+图片网格+放大弹窗)
│   │   ├── result-panel.tsx         # 审核结果面板(结论+违规项+分析)
│   │   ├── feishu-config-dialog.tsx # 飞书配置弹窗(含一键创建表格)
│   │   ├── stats-bar.tsx            # 统计栏(总计/待审/合规/违规/待复核/错误)
│   │   └── rules-config.tsx         # 审核规则配置(5大维度+自定义)
│   └── ui/                          # shadcn/ui预装组件
├── hooks/
│   └── use-toast.ts                 # Toast通知
└── lib/
    ├── types.ts                     # 共享类型定义
    └── utils.ts                     # cn工具函数
```

## 核心类型定义 (src/lib/types.ts)

```typescript
export interface ProductLink {
  id: string;
  url: string;
  name?: string;       // 产品名称(从Excel解析)
  sku?: string;        // SKU编号(从Excel解析)
  rawRow?: Record<string, string>; // Excel原始行数据
}

export interface ScrapedImage {
  url: string;
  originalUrl?: string;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
}

export interface ScrapedContent {
  title: string;
  textContent: string;
  images: ScrapedImage[];
  url: string;
}

export interface Violation {
  severity: '高' | '中' | '低';
  category: string;     // 虚假宣传/知识产权侵权/违禁品/价格欺诈/误导性图片
  description: string;
  evidence: string;
}

export interface AuditRules {
  checkFalseAdvertising: boolean;    // 虚假宣传
  checkInfringement: boolean;        // 知识产权侵权
  checkProhibitedItems: boolean;     // 违禁品
  checkPriceFraud: boolean;          // 价格欺诈
  checkMisleadingImages: boolean;    // 误导性图片
  customRules: string;               // 自定义规则
}

export interface AuditResult {
  id: string;
  productLink: ProductLink;
  status: 'pending' | 'scraping' | 'auditing' | 'passed' | 'violated' | 'error';
  scrapedContent?: ScrapedContent;
  conclusion?: '合规' | '违规' | '待人工复核';
  violations: Violation[];
  auditDetail?: string;
  errorMessage?: string;
  timestamp: number;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  appToken: string;     // 多维表格App Token (URL中 /base/ 后面的字符串)
  tableId: string;      // 数据表ID
}
```

## 后端API路由详细设计

### 1. POST /api/upload
上传并解析Excel/CSV文件，自动识别URL列。

**处理流程：**
1. 接收FormData，提取file字段
2. 用xlsx库读取文件为buffer，解析为workbook
3. 遍历第一个sheet的所有行，找出包含URL的列（匹配 http/https）
4. 也识别"名称/产品名/name/title"列和"SKU"列
5. 对每行URL生成 `ProductLink` 对象，id格式 `link_excel_${rowIndex}`
6. 返回 `{ links: ProductLink[], detectedColumns, totalRows, validLinks }`

### 2. POST /api/fetch — 网页内容抓取（核心，最复杂）

**双重抓取策略：SDK优先 → 降级fetch**

**阶段1：FetchClient SDK抓取**
```typescript
import { FetchClient } from 'coze-coding-dev-sdk';
const client = new FetchClient();
const result = await client.fetch({ url });
// result包含: title, text_content, image_list(display_url/image_url)
```
- SDK成功：提取title、text_content、image_list
- 图片处理：display_url为空则用image_url，去掉CDN尺寸后缀(-800/-1024/-50等)获取原图URL
- 过滤-50极小缩略图（50px无审核价值）

**阶段2：SDK失败时降级为原生fetch**
```typescript
const response = await fetch(url, {
  headers: { 'User-Agent': 'Mozilla/5.0 ...' },
  signal: AbortSignal.timeout(15000),
  redirect: 'follow',
});
const html = await response.text();
```

**降级fetch内容提取（3层文字+3层图片）：**

文字提取：
1. HTML标签清洗：去script/style/nav/footer，提取<body>内文本
2. Product JSON提取：从HTML中找 `"product":{...}` JSON块，解析出 title/min_price/max_price/description/variants
3. 合并文字，阈值200字符以下视为内容不足

图片提取（优先级从高到低）：
1. **Product JSON图片**：从product对象提取 feature_image(字符串或对象.url)、medias数组(.url)、variants中image(.url)
2. **Gallery JSON数组**：匹配 `"gallery":[...]` 提取每个item的url字段
3. **JSON-LD ProductGroup**：匹配 `<script type="application/ld+json">` 中ProductGroup的image数组
4. **HTML标签提取**：`<img>` 的8种属性(src/data-src/data-lazy-src/data-original/data-lazy/data-zoom-image/data-srcset/srcset)、`<source>` 的srcset、background-image CSS
5. **内嵌JSON正则扫描**：`/cdn/image/` 路径自动拼接域名，以及宽泛路径扫描兜底（少于3张图片时扫描所有图片路径）

**图片URL处理：**
- 相对路径→绝对路径（基于目标URL的origin）
- JSON中 `\/` 转义→`/`（JSON.parse自动处理）
- CDN尺寸后缀清理：`-800`/`-1024`/`-50`/`-200`/`-400`/`-600`/`_800x800` 等模式去掉
- 过滤非产品图片：20+关键词（icon/logo/tracking/payment/favicon/badge/avatar等）
- URL尺寸检测：路径含 `_50x50` / `-50x50` / `_50.` 的跳过
- 产品图片优先排序：含 shopify/alicdn/amazon/cdn/image 等关键词的排前面
- 去重：按URL去重，最多20张

**SDK文字成功但图片为空时**：自动补一次HTML图片提取

**错误处理**：SDK和降级都失败才返回错误，业务错误返回200+success:false，不返回500

### 3. POST /api/audit — AI合规审核

**使用LLMClient + 多模态模型**
```typescript
import { LLMClient } from 'coze-coding-dev-sdk';
const client = new LLMClient();
// 模型ID: 'doubao-seed-2-0-pro-260215' (支持图文输入)
```

**Prompt设计（中文）：**
- 系统提示：你是跨境电商合规审核专家，根据规则判断产品页面是否违规
- 规则列表：根据AuditRules开关动态生成5大审核维度描述
- 自定义规则：如果customRules非空则追加
- 用户消息：包含产品标题、文字内容（限3000字）、图片（多模态，最多5张，用image_url类型传入）
- 要求输出严格JSON：`{ "conclusion": "合规/违规/待人工复核", "violations": [{severity,category,description,evidence}], "analysis": "详细分析" }`

**消息格式：**
```typescript
const messages: Array<{role: string; content: string | Array<{type: string; text?: string; image_url?: {url: string; detail?: string}>}>} = [
  { role: 'system', content: systemPrompt },
  { role: 'user', content: [
    { type: 'text', text: `产品标题: ${title}\n\n产品文字内容:\n${textContent}` },
    ...images.slice(0,5).map(img => ({ type: 'image_url', image_url: { url: img.url, detail: 'low' } }))
  ]}
];
```

**响应处理：** 从LLM响应文本中提取JSON（支持markdown代码块包裹），解析后返回

### 4. POST /api/feishu — 推送飞书多维表格

**飞书开放平台API调用流程：**
1. 获取tenant_access_token：`POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`
2. 获取已有字段列表：`GET https://open.feishu.cn/open-apis/bitable/v1/apps/{appToken}/tables/{tableId}/fields`
3. 自动创建缺失字段（对比REQUIRED_FIELDS）
4. 逐条创建记录：`POST https://open.feishu.cn/open-apis/bitable/v1/apps/{appToken}/tables/{tableId}/records`

**REQUIRED_FIELDS定义（11个字段）：**
| 字段名 | 飞书字段类型 | 特殊处理 |
|--------|------------|---------|
| 产品链接 | 1 (多行文本) | — |
| 产品名称 | 1 (多行文本) | — |
| SKU | 1 (多行文本) | — |
| 审核结论 | 3 (单选) | 选项: 合规/违规/待人工复核 |
| 违规项 | 1 (多行文本) | 格式: [严重程度] 类别: 描述 (证据: ...) |
| 违规数量 | 2 (数字) | — |
| 页面标题 | 1 (多行文本) | — |
| 页面文字内容 | 1 (多行文本) | 最多5000字截断 |
| 图片链接 | 1 (多行文本) | 每行一个URL |
| 审核详情 | 1 (多行文本) | — |
| 审核时间 | 5 (日期) | unix毫秒时间戳 |

**写入记录时字段适配：**
- 根据实际字段类型适配值：超链接类型({link, text})、数字类型(toNumber)、其他类型直接字符串
- 返回 `{ success, total, successCount, failCount, details, fieldStatus: { created, skipped } }`

### 5. POST /api/feishu/create-bitable — 一键创建多维表格

**流程：**
1. 获取tenant_access_token
2. 创建多维表格：`POST https://open.feishu.cn/open-apis/bitable/v1/apps` body: `{ name: "跨境电商审核结果" }`
3. 获取默认数据表ID
4. 逐个创建11个REQUIRED_FIELDS
5. 返回 `{ success, appToken, tableId, tableName, fieldCount, url }`

## 前端页面设计

### 设计风格（暗色监控面板）

| 元素 | 值 |
|------|---|
| 主背景 | #0f1117 |
| 卡片/面板 | #1a1d27 |
| 合规色 | #10b981 (emerald) |
| 违规色 | #ef4444 (red) |
| 进度色 | #3b82f6 (blue) |
| 文字主色 | #e2e8f0 |
| 文字辅助色 | #94a3b8 |
| 圆角 | ≤12px |
| 图标 | lucide-react 线条型 |

### 页面结构

**初始状态（无链接时）：** 居中布局
- 盾牌图标 + 标题 + 说明文字
- UploadZone组件（单条链接输入 + Excel上传）

**有链接后：** 三栏布局 (grid-cols-12)
- 顶部：sticky导航栏(标题+飞书配置) + 统计栏(StatsBar) + 操作栏(审核/推送按钮)
- 左栏(col-span-3)：UploadZone + LinkList + RulesConfig
- 中栏(col-span-5)：ContentPreview
- 右栏(col-span-4)：ResultPanel

### 主页面状态管理 (page.tsx)

```typescript
const [results, setResults] = useState<AuditResult[]>([]);
const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
const [isUploading, setIsUploading] = useState(false);
const [isAuditing, setIsAuditing] = useState(false);
const [isPushing, setIsPushing] = useState(false);
const [feishuConfig, setFeishuConfig] = useState<FeishuConfig | null>(null);
const [rules, setRules] = useState<AuditRules>({...});
```

**核心逻辑：**

1. **handleLinksAdded** — 新链接追加到results（已存在的URL重置为pending允许重新审核），按URL去重

2. **auditOne** — 单条审核：scraping→fetch API→auditing→audit API→更新status/conclusion/violations/auditDetail

3. **handleBatchAudit** — 并发审核（并发池模式，默认3个worker）
```typescript
const concurrency = 3;
let index = 0;
async function runNext() {
  while (index < total) {
    const currentIndex = index++;
    await auditOne(pendingResults[currentIndex]);
  }
}
const workers = Array.from({ length: Math.min(concurrency, total) }, () => runNext());
await Promise.all(workers);
```

4. **handlePushFeishu** — 推送已完成的审核结果到飞书

### 组件设计

**UploadZone：** 
- 上半部分：单条链接输入框（LinkIcon + Input + 添加按钮），支持回车提交，URL格式校验(http/https)
- 分隔线：文字"或"
- 下半部分：Excel拖拽上传区（虚线边框，支持.xlsx/.xls/.csv）

**LinkList：**
- 列表项：左侧状态图标(Loader旋转/scraping/auditing/CheckCircle绿/XCircle红/AlertTriangle黄) + URL文本(截断显示，font-mono)
- 选中项高亮(bg-slate-700/50)
- 滚动容器(max-h-[400px])

**ContentPreview：**
- 页面标题区(h3)
- 文字内容区(可折叠，最大200行，whitespace-pre-wrap)
- 产品图片区：网格展示(grid-cols-3)，图片hover放大效果，点击打开Lightbox弹窗
- 图片加载失败三级降级：thumbnailUrl → url → originalUrl

**ResultPanel：**
- 审核结论：合规(绿)/违规(红)/待人工复核(黄) + 盾牌图标
- 违规项列表：每项显示严重程度标签(高-红/中-黄/低-蓝) + 类别 + 描述 + 证据
- 审核详情：AI分析全文(可折叠)
- 审核失败：红色错误面板

**FeishuConfigDialog：**
- Dialog弹窗，包含DialogDescription(无障碍)
- 4个输入字段：App ID / App Secret / App Token(说明:URL中/base/后) / Table ID(说明:数据表ID)
- "一键创建多维表格"按钮(调用 /api/feishu/create-bitable，成功后自动填充AppToken和TableId)
- 保存按钮(保存到localStorage)

**StatsBar：** 6项统计：总计/待审核/合规/违规/待复核/错误，各有图标和颜色

**RulesConfig：** 5个Switch开关 + 自定义规则Textarea

## 关键实现细节

### SDK使用规范
```typescript
// LLMClient
import { LLMClient } from 'coze-coding-dev-sdk';
const llmClient = new LLMClient();
const result = await llmClient.chat({
  model: 'doubao-seed-2-0-pro-260215',
  messages: messages,
});
// result为字符串，需手动解析JSON

// FetchClient
import { FetchClient } from 'coze-coding-dev-sdk';
const fetchClient = new FetchClient();
const fetchResult = await fetchClient.fetch({ url });
// fetchResult包含: title, text_content, image_list[{display_url, image_url}]
```

### 飞书API调用
```typescript
// 获取token
const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
});
const { tenant_access_token } = await tokenRes.json();

// 后续请求Header
const headers = {
  'Authorization': `Bearer ${tenant_access_token}`,
  'Content-Type': 'application/json',
};
```

### 图片URL处理
```typescript
// 去掉CDN尺寸后缀获取原图
function stripSizeSuffix(url: string): string {
  return url.replace(/(-\d{3,4})(?=\.\w+$)/, '').replace(/[-_]\d{3,4}x\d{3,4}/, '');
}

// 过滤非产品图片
const FILTER_PATTERNS = [
  'icon', 'logo', 'favicon', 'badge', 'payment', 'visa', 'mastercard', 'paypal',
  'apple-pay', 'google-pay', 'avatar', 'emoji', 'spacer', 'blank', 'pixel',
  'tracking', 'analytics', 'banner-ad', 'social', 'share', 'qr-code', 'trust',
];
```

### SPA网站内容提取
```typescript
// 从HTML中提取product JSON对象
function extractProductJson(html: string): any | null {
  const idx = html.indexOf('"product":{');
  if (idx < 0) return null;
  let depth = 0;
  const start = idx + '"product":'.length;
  for (let i = start; i < Math.min(start + 50000, html.length); i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) return JSON.parse(html.slice(start, i + 1)); }
  }
  return null;
}

// 提取gallery JSON数组
function extractGalleryImages(html: string, baseUrl: string): string[] {
  const match = html.match(/"gallery"\s*:\s*\[/i);
  if (!match) return [];
  // ... 括号匹配提取JSON数组，解析每个item的url字段
}
```

## 构建与运行

- 初始化: `coze init /workspace/projects --template nextjs`
- 安装依赖: `pnpm add xlsx lucide-react coze-coding-dev-sdk@latest`
- 开发: `pnpm dev` (端口5000，HMR)
- 类型检查: `pnpm ts-check`
- Lint: `pnpm lint`
