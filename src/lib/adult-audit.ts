import type { AuditResult, ScrapedContent } from '@/lib/types';

export const ADULT_REQUIRED_EXCEL_COLUMNS = [
  '产品名称',
  '落地页链接',
] as const;

export const ADULT_PREFERRED_EXCEL_COLUMNS = [
  '部门',
  '虚拟SKU编号',
  '真实SKU编号',
  '运营',
  '订单数',
] as const;

export const ADULT_REQUIRED_EXCEL_COLUMN_ALIASES = [
  ['产品名称', '名称', 'name', 'product_name', 'title', '标题'],
  ['落地页链接', '产品链接', '第三方域名链接', '链接', 'url', 'link', '网址', 'landing_page_url', 'product_url'],
] as const;

export const ADULT_PREFERRED_EXCEL_COLUMN_ALIASES = {
  部门: ['部门', 'platform', '平台', 'site', '站点', '店铺'],
  虚拟SKU编号: ['虚拟SKU编号', '虚拟SPU', 'sku', 'SKU', '商品编号', 'product_id', 'id'],
  真实SKU编号: ['真实SKU编号', '真实SPU'],
  运营: ['运营', 'operator'],
  订单数: ['订单数', 'order_count', 'orders'],
} as const;

export type AdultScreeningLabel = '是淫秽产品类' | '非淫秽产品类';
export type AdultAuditConclusion =
  | '淫秽产品违规'
  | '产品通过'
  | '无需处理'
  | '需人工处理'
  | '未审核';

export interface AdultFetchFallback {
  conclusion: AdultAuditConclusion;
  status: AuditResult['status'];
  analysis: string;
}

export const ADULT_NAME_SCREENING_PROMPT = `你是一名严谨的商品审核助手，遵循“宁可错拦，不可漏放”的初筛原则。

请仅根据商品名称判断该商品是否疑似成人/淫秽产品，输出只能是以下两项之一：
- 是淫秽产品类
- 非淫秽产品类

判定为“是淫秽产品类”的常见情况：
1. 直接用于成人性行为或情趣场景的商品，如按摩棒、震动棒、跳蛋、飞机杯、延时环、情趣内衣、润滑剂、SM 用具等。
2. 名称中出现明显性功能、催情、增强性能力、延时、高潮、情趣等表达。
3. 名称中直接出现或变体表达生殖器官、性行为、性暗示短语。
4. 虽然是日常用品，但核心卖点明显围绕性暗示、情趣、私密用途展开。
5. 使用谐音、缩写、拆词、符号绕过审核，但上下文仍可合理推断为上述商品。

判定为“非淫秽产品类”的常见情况：
1. 明确是正常身体部位按摩器，如 Neck Massager、Foot Massager、Back Massager。
2. 普通创意礼品、家居用品、服饰或日用品，名称中没有明确性用途指向。
3. 明确用于医学、教学、科普展示的非情趣用途商品。

待判断商品名称：{product_name}

请严格只输出“是淫秽产品类”或“非淫秽产品类”。`;

export const ADULT_RULE_PROMPT = `请审核该商品落地页的文字与图片，判断最终结果必须是以下四类之一：
- 淫秽产品违规
- 产品通过
- 无需处理
- 需人工处理

先判断页面是否异常：
1. 页面状态异常、403、404、503、访问被拒绝、Not authorized、Access Denied，输出“无需处理”。
2. 页面空白、加载失败、严重损坏、没有任何有效商品信息，输出“需人工处理”。
3. 图片无法辨认、内容极少且无法判断、疑似异常拦截页，输出“需人工处理”。

页面正常时，重点审核三类风险：
1. 是否属于成人情趣用品或其衍生品，包括伪装成私密护理、高潮液、润滑剂、情趣周边等商品。
2. 是否包含清晰可辨认的生殖器官、裸体露点或强性暗示的人体部位展示。
3. 是否包含明显性行为动作、交配姿势、自慰、口交、插入等画面或描述。

输出 JSON，字段要求如下：
{
  "conclusion": "淫秽产品违规" | "产品通过" | "无需处理" | "需人工处理",
  "violations": [
    {
      "type": "image" | "text",
      "category": "违规类别",
      "description": "违规描述",
      "evidence": "证据",
      "severity": "high" | "medium" | "low"
    }
  ],
  "analysis": "详细分析"
}

如果没有命中违规，且页面正常可判定，则输出“产品通过”。`;

export function normalizeAdultScreeningLabel(value: unknown): AdultScreeningLabel {
  if (typeof value !== 'string') return '是淫秽产品类';
  const normalized = value.replace(/\s+/g, '').trim();

  if (
    normalized.includes('非淫秽产品类') ||
    normalized.includes('非成人') ||
    normalized.includes('非情趣') ||
    normalized === '否'
  ) {
    return '非淫秽产品类';
  }

  return '是淫秽产品类';
}

export function normalizeAdultConclusion(value: unknown): AdultAuditConclusion {
  if (typeof value !== 'string') return '需人工处理';
  const normalized = value.replace(/\s+/g, '').trim();

  if (normalized.includes('淫秽产品违规') || normalized === '违规') return '淫秽产品违规';
  if (normalized.includes('产品通过') || normalized === '合规') return '产品通过';
  if (normalized.includes('无需处理')) return '无需处理';
  if (normalized.includes('需人工处理') || normalized.includes('人工复核') || normalized.includes('待人工复核')) {
    return '需人工处理';
  }
  if (normalized.includes('未审核')) return '未审核';

  return '需人工处理';
}

export function getAdultConclusionStatus(conclusion: AdultAuditConclusion): AuditResult['status'] {
  if (conclusion === '产品通过') return 'passed';
  if (conclusion === '淫秽产品违规') return 'violated';
  if (conclusion === '无需处理') return 'unaudited';
  if (conclusion === '未审核') return 'unaudited';
  return 'review';
}

export function isAccessDeniedText(text: string) {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('not authorized') ||
    normalized.includes('access denied') ||
    normalized.includes('forbidden') ||
    normalized.includes('permission denied') ||
    normalized.includes('unauthorized')
  );
}

export function buildAdultFetchFallback(statusCode?: number, fallback?: string): AdultFetchFallback {
  const message = fallback?.trim() || '页面抓取失败';

  if (statusCode === 403 || statusCode === 404 || statusCode === 503) {
    return {
      conclusion: '无需处理',
      status: getAdultConclusionStatus('无需处理'),
      analysis: `页面状态异常（HTTP ${statusCode}），按异常页处理，无需进入图文审核。`,
    };
  }

  if (isAccessDeniedText(message)) {
    return {
      conclusion: '无需处理',
      status: getAdultConclusionStatus('无需处理'),
      analysis: '落地页返回授权失败或访问受限内容，按无需处理输出。',
    };
  }

  return {
    conclusion: '需人工处理',
    status: getAdultConclusionStatus('需人工处理'),
    analysis: `页面抓取失败或内容异常：${message}`,
  };
}

export function detectAdultPageIssue(
  content: ScrapedContent,
  productName?: string
): AdultFetchFallback | null {
  const text = (content.textContent || '').trim();
  const imageCount = content.images?.length ?? 0;

  if (content.statusCode === 403 || content.statusCode === 404 || content.statusCode === 503) {
    return buildAdultFetchFallback(content.statusCode);
  }

  if (text && isAccessDeniedText(text)) {
    return buildAdultFetchFallback(undefined, text);
  }

  const title = (content.title || '').toLowerCase();
  if (title.includes('404') || title.includes('403') || title.includes('access denied')) {
    return {
      conclusion: '无需处理',
      status: getAdultConclusionStatus('无需处理'),
      analysis: '页面标题显示为异常拦截页或错误页，无需进入审核。',
    };
  }

  if (!text && imageCount === 0) {
    return {
      conclusion: '需人工处理',
      status: getAdultConclusionStatus('需人工处理'),
      analysis: productName
        ? `商品“${productName}”的落地页未抓取到有效文字或图片，需人工处理。`
        : '落地页未抓取到有效文字或图片，需人工处理。',
    };
  }

  if (text.replace(/\s+/g, '').length < 20 && imageCount === 0) {
    return {
      conclusion: '需人工处理',
      status: getAdultConclusionStatus('需人工处理'),
      analysis: '落地页内容过少且无有效图片，无法稳定判断，需人工处理。',
    };
  }

  return null;
}
