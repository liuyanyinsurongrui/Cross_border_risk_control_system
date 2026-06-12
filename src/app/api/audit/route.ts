import { NextRequest, NextResponse } from 'next/server';
import type {
  AuditRule,
  AuditRules,
  ModelApiConfig,
  ScrapedContent,
  ScrapedImage,
  ViolationItem,
} from '@/lib/types';

type AuditConclusion = '合规' | '违规' | '待人工复核' | '未审核';
type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

interface ParsedAuditResult {
  conclusion: AuditConclusion;
  violations: ViolationItem[];
  analysis: string;
}

interface RuleResult extends ParsedAuditResult {
  ruleId: string;
  ruleName: string;
  model: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
}

const AUDIT_TEXT_CONTENT_LIMIT = 3200;
const AUDIT_PRODUCT_IMAGE_LIMIT = 2;
const AUDIT_DETAIL_IMAGE_LIMIT = 1;
const AUDIT_IMAGE_DETAIL = 'low' as const;
const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

const BASE_SYSTEM_PROMPT = `你是一名专业的跨境电商合规审核专家。你需要根据给定的审核指令，对跨境电商独立站的产品页面内容进行审核。
请严格按以下 JSON 格式输出审核结果，不要输出任何其他内容：
{
  "conclusion": "合规" | "违规" | "待人工复核",
  "violations": [
    {
      "type": "image" | "text",
      "category": "违规类别",
      "description": "违规描述",
      "evidence": "证据，来自图片描述或文字片段",
      "severity": "high" | "medium" | "low"
    }
  ],
  "analysis": "详细的审核分析过程"
}

审核原则：
- 宁可放过，不可误判。对模糊两可的情况标记为“待人工复核”。
- 违规项必须有具体证据支撑，不可笼统判断。
- severity 判断标准：high=法律风险或消费者权益严重受损，medium=明显违规但不严重，low=轻微不规范。`;

function normalizeBaseUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_ARK_BASE_URL;
  return trimmed.endsWith('/chat/completions')
    ? trimmed.slice(0, -'/chat/completions'.length)
    : trimmed;
}

function getCompletionUrl(modelConfig: ModelApiConfig) {
  const baseUrl = normalizeBaseUrl(modelConfig.modelBaseUrl || modelConfig.baseUrl);
  return `${baseUrl}/chat/completions`;
}

function resolveModel(modelConfig: ModelApiConfig | null | undefined, ruleModel: string) {
  if (!modelConfig?.apiKey?.trim()) return '';
  if (modelConfig.provider === 'ark') return modelConfig.endpointId.trim();
  return modelConfig.modelName.trim() || ruleModel.trim();
}

function extractBalancedJson(text: string): string | null {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = (fencedMatch?.[1] || text).trim();
  const start = source.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  return null;
}

function normalizeConclusion(value: unknown): AuditConclusion {
  if (typeof value !== 'string') return '待人工复核';
  if (value.includes('未审核')) return '未审核';
  if (value.includes('合规') && !value.includes('违规')) return '合规';
  if (value.includes('违规')) return '违规';
  if (value.includes('复核') || value.includes('人工')) return '待人工复核';
  return '待人工复核';
}

function normalizeViolations(value: unknown): ViolationItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((item) => ({
      type: item.type === 'image' ? 'image' : 'text',
      category:
        typeof item.category === 'string' && item.category.trim() ? item.category.trim() : '未分类',
      description:
        typeof item.description === 'string' && item.description.trim()
          ? item.description.trim()
          : '未提供违规描述',
      evidence: typeof item.evidence === 'string' ? item.evidence.trim() : '',
      severity:
        item.severity === 'high' || item.severity === 'medium' || item.severity === 'low'
          ? item.severity
          : 'medium',
    }));
}

function parseAuditResponse(fullResponse: string): ParsedAuditResult {
  const jsonCandidate = extractBalancedJson(fullResponse);

  if (!jsonCandidate) {
    return {
      conclusion: '待人工复核',
      violations: [],
      analysis: fullResponse.trim(),
    };
  }

  try {
    const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
    return {
      conclusion: normalizeConclusion(parsed.conclusion),
      violations: normalizeViolations(parsed.violations),
      analysis:
        typeof parsed.analysis === 'string' && parsed.analysis.trim()
          ? parsed.analysis.trim()
          : fullResponse.trim(),
    };
  } catch {
    return {
      conclusion: '待人工复核',
      violations: [],
      analysis: fullResponse.trim(),
    };
  }
}

function formatAuditErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : 'AI 审核失败';

  if (rawMessage.includes('ChatCompletionRequestMultiContent can only support text')) {
    return '当前配置的模型接入点不支持图片输入。请更换为视觉/多模态 Endpoint ID，或先关闭图片审核后再试。';
  }

  if (
    rawMessage.includes('image_url') &&
    (rawMessage.includes('unsupported') || rawMessage.includes('not support'))
  ) {
    return '当前模型不支持图片内容，请更换为支持视觉的多模态模型或接入点。';
  }

  if (rawMessage.includes('No such model') || rawMessage.includes('model_not_found')) {
    return '当前配置的模型或 Endpoint ID 无效，请检查模型配置中的接入点或模型名是否正确。';
  }

  if (rawMessage.includes('Incorrect API key') || rawMessage.includes('invalid_api_key')) {
    return 'API Key 无效，请检查模型配置中的 API Key 是否正确。';
  }

  return `AI 审核失败：${rawMessage}`;
}

function buildAuditTextContent(text: string): { text: string; truncated: boolean } {
  const normalizedText = text.replace(/\s+/g, ' ').trim();

  if (normalizedText.length <= AUDIT_TEXT_CONTENT_LIMIT) {
    return { text: normalizedText, truncated: false };
  }

  return {
    text: normalizedText.slice(0, AUDIT_TEXT_CONTENT_LIMIT),
    truncated: true,
  };
}

function selectImagesForAudit(content: ScrapedContent): ScrapedImage[] {
  const productImages = (content.productImages ?? []).slice(0, AUDIT_PRODUCT_IMAGE_LIMIT);
  const detailImages = (content.detailImages ?? []).slice(0, AUDIT_DETAIL_IMAGE_LIMIT);

  if (productImages.length > 0 || detailImages.length > 0) {
    return [...productImages, ...detailImages];
  }

  return (content.images ?? []).slice(0, AUDIT_PRODUCT_IMAGE_LIMIT + AUDIT_DETAIL_IMAGE_LIMIT);
}

function buildPrompt(content: ScrapedContent, rulePrompt: string) {
  const auditTextContent = buildAuditTextContent(content.textContent ?? '');
  let textPrompt = '请审核以下跨境电商产品页面内容：\n\n';
  textPrompt += `页面标题：${content.title}\n`;
  textPrompt += `页面 URL：${content.url}\n\n`;
  textPrompt += `页面文字内容：\n${auditTextContent.text}\n\n`;

  if (auditTextContent.truncated) {
    textPrompt += `补充说明：原始页面文字较长，当前仅截取前 ${AUDIT_TEXT_CONTENT_LIMIT} 个字符用于快速初审。\n\n`;
  }

  textPrompt += `审核指令：${rulePrompt}\n\n`;
  textPrompt += '请根据以上审核指令对内容进行检查，严格按要求的 JSON 格式输出结果。';

  return textPrompt;
}

function buildUserContent(content: ScrapedContent, rulePrompt: string): ChatContentPart[] {
  const userContentParts: ChatContentPart[] = [{ type: 'text', text: buildPrompt(content, rulePrompt) }];
  const imagesToAudit = selectImagesForAudit(content);

  for (const img of imagesToAudit) {
    const imageUrl = img.url || img.originalUrl;
    if (!imageUrl) continue;

    userContentParts.push({
      type: 'image_url',
      image_url: { url: imageUrl, detail: AUDIT_IMAGE_DETAIL },
    });
  }

  const totalImages =
    (content.productImages?.length ?? 0) + (content.detailImages?.length ?? 0) ||
    (content.images?.length ?? 0);

  if (totalImages > imagesToAudit.length) {
    userContentParts.push({
      type: 'text',
      text: `注意：页面共包含 ${totalImages} 张图片（素材图 ${
        content.productImages?.length ?? 0
      } 张，详情图 ${
        content.detailImages?.length ?? 0
      } 张），当前仅抽样审核 ${imagesToAudit.length} 张以提升响应速度。`,
    });
  }

  return userContentParts;
}

async function callChatCompletion(
  modelConfig: ModelApiConfig,
  model: string,
  content: ScrapedContent,
  rulePrompt: string
) {
  const response = await fetch(getCompletionUrl(modelConfig), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${modelConfig.apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: BASE_SYSTEM_PROMPT },
        { role: 'user', content: buildUserContent(content, rulePrompt) },
      ],
    }),
  });

  const text = await response.text();
  let data: ChatCompletionResponse;
  try {
    data = JSON.parse(text) as ChatCompletionResponse;
  } catch {
    throw new Error(`模型接口返回了无法解析的内容：${text.slice(0, 200)}`);
  }

  if (!response.ok || data.error) {
    throw new Error(data.error?.message || `模型接口请求失败（HTTP ${response.status}）`);
  }

  const fullResponse = data.choices?.[0]?.message?.content;
  if (!fullResponse) {
    throw new Error('模型没有返回审核内容');
  }

  return fullResponse;
}

async function auditWithRule(
  content: ScrapedContent,
  rule: AuditRule,
  modelConfig?: ModelApiConfig | null
): Promise<RuleResult> {
  const resolvedModel = resolveModel(modelConfig, rule.model);

  if (!modelConfig?.apiKey?.trim() || !resolvedModel) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      model: resolvedModel,
      conclusion: '未审核',
      violations: [],
      analysis: '当前规则未配置可用模型，请先在页面右上角完成模型配置。',
    };
  }

  const fullResponse = await callChatCompletion(modelConfig, resolvedModel, content, rule.prompt);

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    model: resolvedModel,
    ...parseAuditResponse(fullResponse),
  };
}

function aggregateResults(ruleResults: RuleResult[]): ParsedAuditResult {
  if (ruleResults.length === 0) {
    return { conclusion: '待人工复核', violations: [], analysis: '无审核规则' };
  }

  if (ruleResults.length === 1) {
    return {
      conclusion: ruleResults[0].conclusion,
      violations: ruleResults[0].violations,
      analysis: ruleResults[0].analysis,
    };
  }

  const allViolations: ViolationItem[] = [];
  const analyses: string[] = [];
  let hasViolation = false;
  let allCompliant = true;

  for (const ruleResult of ruleResults) {
    if (ruleResult.conclusion === '违规') {
      hasViolation = true;
      allCompliant = false;

      for (const violation of ruleResult.violations) {
        allViolations.push({
          ...violation,
          category: `[${ruleResult.ruleName}] ${violation.category}`,
        });
      }
    } else if (ruleResult.conclusion !== '合规') {
      allCompliant = false;
    }

    analyses.push(`【${ruleResult.ruleName}】(模型: ${ruleResult.model})\n${ruleResult.analysis}`);
  }

  return {
    conclusion: hasViolation ? '违规' : allCompliant ? '合规' : '待人工复核',
    violations: allViolations,
    analysis: analyses.join('\n\n---\n\n'),
  };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      content: ScrapedContent;
      rules?: AuditRules;
      modelConfig?: ModelApiConfig | null;
    };

    const { content, rules, modelConfig } = body;

    if (!content) {
      return NextResponse.json({ error: '缺少审核内容' }, { status: 400 });
    }

    const enabledRules = rules?.rules?.filter((rule) => rule.enabled) || [];

    if (enabledRules.length === 0) {
      return NextResponse.json({
        success: true,
        result: {
          conclusion: '未审核',
          violations: [],
          analysis: '未启用任何审核规则，请先在规则配置中启用至少一条规则。',
        },
        ruleResults: [],
      });
    }

    const ruleResults: RuleResult[] = [];
    const concurrency = 2;
    let ruleIndex = 0;

    async function processNextRule() {
      while (ruleIndex < enabledRules.length) {
        const currentIndex = ruleIndex;
        ruleIndex += 1;
        ruleResults.push(await auditWithRule(content, enabledRules[currentIndex], modelConfig));
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(concurrency, enabledRules.length) }, () => processNextRule())
    );

    return NextResponse.json({
      success: true,
      result: aggregateResults(ruleResults),
      ruleResults,
    });
  } catch (error) {
    return NextResponse.json({ error: formatAuditErrorMessage(error) }, { status: 500 });
  }
}
