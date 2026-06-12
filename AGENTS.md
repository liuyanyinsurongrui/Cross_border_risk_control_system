# AGENTS.md - 跨境电商独立站链接违规审核系统

## 项目概览

AI驱动的跨境电商独立站产品链接违规审核Web应用。支持批量导入产品链接、自动抓取网页内容（文字+图片）、智能合规审核、审核结果推送飞书多维表格。

## 技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4
- **AI/LLM**: coze-coding-dev-sdk (LLMClient + FetchClient + S3Storage)
- **Excel解析**: xlsx
- **图标**: lucide-react

## 目录结构

```
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── upload/route.ts    # Excel文件上传与解析
│   │   │   ├── fetch/route.ts     # 网页内容抓取(FetchClient)
│   │   │   ├── audit/route.ts     # AI合规审核(LLMClient)
│   │   │   └── feishu/route.ts    # 飞书多维表格推送
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   └── page.tsx               # 主页面(三栏布局)
│   ├── components/
│   │   ├── audit/
│   │   │   ├── upload-zone.tsx    # Excel上传组件
│   │   │   ├── link-list.tsx      # 链接列表组件
│   │   │   ├── content-preview.tsx # 抓取内容预览
│   │   │   ├── result-panel.tsx   # 审核结果面板
│   │   │   ├── feishu-config-dialog.tsx # 飞书配置弹窗
│   │   │   ├── stats-bar.tsx      # 统计栏
│   │   │   └── rules-config.tsx   # 审核规则配置
│   │   └── ui/                    # shadcn/ui组件库
│   ├── hooks/
│   │   ├── use-toast.ts           # Toast通知Hook
│   │   └── use-mobile.ts
│   └── lib/
│       ├── types.ts               # 共享类型定义
│       └── utils.ts               # 工具函数
```

## 核心API路由

### POST /api/upload
上传并解析Excel文件，自动识别链接列，返回结构化链接列表。
- 输入: FormData (file字段)
- 输出: `{ links, detectedColumns, totalRows, validLinks }`

### POST /api/fetch
抓取指定URL的网页内容(文字+图片)，使用FetchClient SDK。
- 输入: `{ url: string }`
- 输出: `{ success, content: { title, textContent, images, url } }`

### POST /api/audit
AI合规审核，使用LLMClient + 多模态模型(文字+图片审核)。
- 输入: `{ content: ScrapedContent, rules?: AuditRules }`
- 输出: `{ success, result: { conclusion, violations, analysis } }`

### POST /api/feishu
将审核结果推送至飞书多维表格。
- 输入: `{ config: FeishuConfig, results: AuditResult[] }`
- 输出: `{ success, total, successCount, failCount, details }`

## 构建与测试命令

- 开发: `pnpm dev` (端口5000，支持HMR)
- 构建: `pnpm build`
- 类型检查: `pnpm ts-check`
- Lint: `pnpm lint`
- 全量验证: `pnpm validate`

## 编码规范

- TypeScript strict模式，禁止隐式any
- 使用coze-coding-dev-sdk的LLMClient/FetchClient/S3Storage，不要自建替代方案
- 后端API路由必须使用HeaderUtils.extractForwardHeaders提取请求头
- 前端组件使用'use client'指令，动态内容用useEffect+useState避免hydration错误
- 仅使用pnpm作为包管理器
