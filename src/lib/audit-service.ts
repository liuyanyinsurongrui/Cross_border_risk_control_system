import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { detectAdultPageIssue } from '@/lib/adult-audit';
import type {
  AuditRule,
  AuditRules,
  ModelApiConfig,
  RuleAuditResult,
  ScrapedContent,
  ScrapedImage,
  ViolationItem,
} from '@/lib/types';

const execFileAsync = promisify(execFile);

type AuditConclusion = '合规' | '违规' | '待人工复核' | '未审核';
type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

interface ParsedAuditResult {
  conclusion: AuditConclusion;
  violations: ViolationItem[];
  analysis: string;
}

interface InternalRuleResult extends ParsedAuditResult {
  ruleId: string;
  ruleName: string;
  model: string;
  stage: 'audit';
}

interface IntentMatchResult {
  ruleId: string;
  ruleName: string;
  model: string;
  matched: boolean;
  analysis: string;
}

interface MatchedRulesResult {
  matchedRules: AuditRule[];
  ruleResults: RuleAuditResult[];
  analysis: string;
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
const INTENT_TEXT_CONTENT_LIMIT = 1800;
const AUDIT_PRODUCT_IMAGE_LIMIT = 2;
const AUDIT_DETAIL_IMAGE_LIMIT = 1;
const AUDIT_IMAGE_DETAIL = 'low' as const;
const AUDIT_IMAGE_DOWNLOAD_TIMEOUT_MS = 10000;
const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const SUPPORTED_AUDIT_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
]);
const auditImageCache = new Map<string, Promise<string | null>>();

const BASE_SYSTEM_PROMPT = `你是一名专业的跨境电商合规审核专家。你需要根据给定的审核指令，对跨境电商独立站的产品页面内容进行审核。请严格按以下 JSON 格式输出审核结果，不要输出任何其他内容：
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

const RULE_INTENT_SYSTEM_PROMPT =
  '你是一名商品规则意图识别助手。请根据规则提示词和商品信息判断该商品是否需要进入该规则的内容审核。输出只能是“命中”或“不命中”，不要输出其他内容。';

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
  const normalized = value.replace(/\s+/g, '').trim();

  if (!normalized) return '待人工复核';
  if (normalized.includes('未审核')) return '未审核';
  if (normalized.includes('无需处理')) return '未审核';
  if (normalized.includes('产品通过')) return '合规';
  if (normalized.includes('合规') && !normalized.includes('违规')) return '合规';
  if (normalized.includes('淫秽产品违规')) return '违规';
  if (normalized.includes('成人淫秽产品违规')) return '违规';
  if (normalized.includes('违规')) return '违规';
  if (normalized.includes('复核') || normalized.includes('人工')) return '待人工复核';
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
    const parsedConclusion =
      parsed.conclusion ??
      parsed['产品审核结果'] ??
      parsed.result ??
      parsed['结论'];
    const parsedAnalysis =
      parsed.analysis ??
      parsed['产品判断依据'] ??
      parsed.reason ??
      parsed['分析'] ??
      parsed['判断依据'];

    return {
      conclusion: normalizeConclusion(parsedConclusion),
      violations: normalizeViolations(parsed.violations),
      analysis:
        typeof parsedAnalysis === 'string' && parsedAnalysis.trim()
          ? parsedAnalysis.trim()
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

export function formatAuditErrorMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : 'AI 审核失败';

  if (rawMessage.includes('ChatCompletionRequestMultiContent can only support text')) {
    return '当前配置的模型接入点不支持图片输入，请切换为支持视觉的多模态模型。';
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

function buildAuditTextContent(
  text: string,
  limit: number = AUDIT_TEXT_CONTENT_LIMIT
): { text: string; truncated: boolean } {
  const normalizedText = text.replace(/\s+/g, ' ').trim();

  if (normalizedText.length <= limit) {
    return { text: normalizedText, truncated: false };
  }

  return {
    text: normalizedText.slice(0, limit),
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

function shouldConvertImageForAudit(mimeType: string) {
  const normalizedMimeType = mimeType.toLowerCase().split(';')[0].trim();
  return !SUPPORTED_AUDIT_IMAGE_MIME_TYPES.has(normalizedMimeType);
}

async function convertAuditImageToJpeg(file: { bytes: Buffer; fileName: string }) {
  const tempDir = path.join(os.tmpdir(), 'audit-model-image-convert');
  await fs.mkdir(tempDir, { recursive: true });

  const inputPath = path.join(tempDir, `${randomUUID()}-${file.fileName}`);
  const outputPath = path.join(tempDir, `${randomUUID()}.jpg`);

  try {
    await fs.writeFile(inputPath, file.bytes);
    const script = [
      'from PIL import Image',
      'import sys',
      'input_path, output_path = sys.argv[1], sys.argv[2]',
      'image = Image.open(input_path)',
      'if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):',
      '    background = Image.new("RGB", image.size, (255, 255, 255))',
      '    rgba_image = image.convert("RGBA")',
      '    background.paste(rgba_image, mask=rgba_image.split()[-1])',
      '    image = background',
      'else:',
      '    image = image.convert("RGB")',
      'image.save(output_path, format="JPEG", quality=88, optimize=True)',
    ].join('\n');

    await execFileAsync('python', ['-c', script, inputPath, outputPath], {
      windowsHide: true,
      timeout: AUDIT_IMAGE_DOWNLOAD_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });

    return await fs.readFile(outputPath);
  } finally {
    await Promise.allSettled([fs.rm(inputPath, { force: true }), fs.rm(outputPath, { force: true })]);
  }
}

async function buildAuditImageDataUrl(imageUrl: string, index: number) {
  if (!imageUrl) return null;
  if (auditImageCache.has(imageUrl)) {
    return await auditImageCache.get(imageUrl);
  }

  const task = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AUDIT_IMAGE_DOWNLOAD_TIMEOUT_MS);

    try {
      const response = await fetch(imageUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          Referer: imageUrl,
        },
        redirect: 'follow',
      });

      if (!response.ok) {
        throw new Error(`下载审核图片失败（HTTP ${response.status}）`);
      }

      const mimeType = response.headers.get('content-type') || 'image/jpeg';
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length) return null;

      let finalBytes = bytes;
      let finalMimeType = mimeType.toLowerCase().split(';')[0].trim() || 'image/jpeg';

      if (shouldConvertImageForAudit(finalMimeType)) {
        finalBytes = await convertAuditImageToJpeg({
          bytes,
          fileName: `audit-image-${index + 1}`,
        });
        finalMimeType = 'image/jpeg';
      }

      return `data:${finalMimeType};base64,${finalBytes.toString('base64')}`;
    } catch (error) {
      console.warn('[Audit] image preprocess skipped', {
        imageUrl,
        error: error instanceof Error ? error.message : error,
      });
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  })();

  auditImageCache.set(imageUrl, task);
  return await task;
}

function buildPrompt(content: ScrapedContent, rulePrompt: string) {
  const auditTextContent = buildAuditTextContent(content.textContent ?? '');
  const productName = content.productName?.trim() || content.title;
  let textPrompt = '请审核以下跨境电商产品页面内容：\n\n';
  textPrompt += `商品名称：${productName}\n`;
  textPrompt += `页面标题：${content.title}\n`;
  textPrompt += `页面 URL：${content.url}\n\n`;
  textPrompt += `页面文字内容：\n${auditTextContent.text}\n\n`;

  if (auditTextContent.truncated) {
    textPrompt += `补充说明：原始页面文字较长，当前仅截取前 ${AUDIT_TEXT_CONTENT_LIMIT} 个字符用于快速初审。\n\n`;
  }

  textPrompt += `审核指令：${rulePrompt}\n\n`;
  textPrompt +=
    '请综合商品名称、页面标题、页面 URL、页面正文和图片内容进行判断。你的职责只是在当前规则下给出标准化审核结果。不要输出飞书字段名、表结构名或任何与存储映射相关的内容，只输出要求的 JSON 结果。';

  return textPrompt;
}

async function buildUserContent(content: ScrapedContent, rulePrompt: string): Promise<ChatContentPart[]> {
  const userContentParts: ChatContentPart[] = [{ type: 'text', text: buildPrompt(content, rulePrompt) }];
  const imagesToAudit = selectImagesForAudit(content);

  const imageUrls = await Promise.all(
    imagesToAudit.map((img, index) => buildAuditImageDataUrl(img.url || img.originalUrl || '', index))
  );
  const processedImageCount = imageUrls.filter(Boolean).length;
  const skippedImageCount = imageUrls.length - processedImageCount;

  for (const imageUrl of imageUrls) {
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
      text: `补充说明：当前页面共识别到 ${totalImages} 张图片（素材图 ${content.productImages?.length ?? 0} 张、详情图 ${content.detailImages?.length ?? 0} 张），为保证审核速度，本次仅抽样处理前 ${imagesToAudit.length} 张图片给模型。`,
    });
  }

  if (skippedImageCount > 0) {
    userContentParts.push({
      type: 'text',
      text: `补充说明：有 ${skippedImageCount} 张抽样图片预处理失败，未发送给模型；本次实际送审图片数为 ${processedImageCount} 张。`,
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
  const userContent = await buildUserContent(content, rulePrompt);

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
        { role: 'user', content: userContent },
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

async function callTextOnlyCompletion(
  modelConfig: ModelApiConfig,
  model: string,
  systemPrompt: string,
  userPrompt: string
) {
  const response = await fetch(getCompletionUrl(modelConfig), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${modelConfig.apiKey.trim()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
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

  return String(fullResponse);
}

function truncateIntentTextContent(text: string) {
  return buildAuditTextContent(text, INTENT_TEXT_CONTENT_LIMIT);
}

function buildIntentScreeningPrompt(rule: AuditRule, content: ScrapedContent) {
  const productName = content.productName?.trim() || content.title.trim();
  const pageTitle = content.title.trim();
  const pageUrl = content.url.trim();
  const textContent = truncateIntentTextContent(content.textContent ?? '');
  const customPrompt = rule.screeningPrompt?.trim();

  if (customPrompt) {
    return customPrompt
      .replaceAll('{product_name}', productName)
      .replaceAll('{page_title}', pageTitle)
      .replaceAll('{page_url}', pageUrl)
      .replaceAll('{text_content}', textContent.text);
  }

  let prompt = `请判断该商品是否需要进入规则“${rule.name}”的后续内容审核。\n\n`;
  prompt += `规则说明：\n${rule.prompt}\n\n`;
  prompt += `商品名称：${productName}\n`;
  prompt += `页面标题：${pageTitle}\n`;
  prompt += `页面 URL：${pageUrl}\n`;
  prompt += `页面文字内容：\n${textContent.text}\n\n`;
  if (textContent.truncated) {
    prompt += `补充说明：页面文字较长，当前仅截取前 ${INTENT_TEXT_CONTENT_LIMIT} 个字符用于意图识别。\n\n`;
  }
  prompt +=
    '如果该商品从语义上看需要进入这条规则的正式内容审核，请只输出“命中”。如果明显不属于这条规则的审核范围，请只输出“不命中”。不要补充解释，不要返回 JSON。';
  return prompt;
}

async function matchRulesByIntent(
  content: ScrapedContent,
  rules: AuditRule[],
  modelConfig?: ModelApiConfig | null
): Promise<MatchedRulesResult> {
  const enabledRules = rules.filter((rule) => rule.enabled);
  if (enabledRules.length === 0) {
    return { matchedRules: [], ruleResults: [], analysis: '未启用任何规则。' };
  }

  const resolvedModel = resolveModel(modelConfig, '');
  if (!modelConfig?.apiKey?.trim() || !resolvedModel) {
    const fallbackRuleResults: RuleAuditResult[] = enabledRules.map((rule) => ({
      ruleId: rule.id,
      ruleName: `${rule.name} - 意图识别`,
      model: 'system',
      conclusion: '未审核',
      violations: [],
      analysis: '当前未配置可用模型，无法执行规则意图识别，默认放行到全部已启用规则。',
      stage: 'intent',
    }));

    return {
      matchedRules: enabledRules,
      ruleResults: fallbackRuleResults,
      analysis: '当前未配置可用模型，无法执行规则意图识别，默认放行到全部已启用规则。',
    };
  }

  const intentResults: IntentMatchResult[] = [];

  for (const rule of enabledRules) {
    const response = await callTextOnlyCompletion(
      modelConfig,
      resolvedModel,
      RULE_INTENT_SYSTEM_PROMPT,
      buildIntentScreeningPrompt(rule, content)
    );
    const normalizedResponse = response.replace(/\s+/g, '').trim();
    const matched =
      normalizedResponse.includes('命中') && !normalizedResponse.includes('不命中');

    intentResults.push({
      ruleId: rule.id,
      ruleName: rule.name,
      model: resolvedModel,
      matched,
      analysis: normalizedResponse || '空响应',
    });
  }

  return {
    matchedRules: enabledRules.filter((rule) =>
      intentResults.some((result) => result.ruleId === rule.id && result.matched)
    ),
    ruleResults: intentResults.map((result) => ({
      ruleId: result.ruleId,
      ruleName: `${result.ruleName} - 意图识别`,
      model: result.model,
      conclusion: result.matched ? '命中' : '未命中',
      violations: [],
      analysis: result.analysis,
      stage: 'intent',
    })),
    analysis: intentResults
      .map((result) => `【${result.ruleName}】${result.matched ? '命中' : '未命中'}：${result.analysis}`)
      .join('\n'),
  };
}

export async function screenAuditRulesByIntent(
  content: ScrapedContent,
  rules?: AuditRules,
  modelConfig?: ModelApiConfig | null
) {
  const enabledRules = rules?.rules?.filter((rule) => rule.enabled) || [];
  return matchRulesByIntent(content, enabledRules, modelConfig);
}

async function auditWithRule(
  content: ScrapedContent,
  rule: AuditRule,
  modelConfig?: ModelApiConfig | null
): Promise<InternalRuleResult> {
  const resolvedModel = resolveModel(modelConfig, rule.model);

  if (!modelConfig?.apiKey?.trim() || !resolvedModel) {
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      model: resolvedModel,
      conclusion: '未审核',
      violations: [],
      analysis: '当前规则未配置可用模型，请先在页面右上角完成模型配置。',
      stage: 'audit',
    };
  }

  const fullResponse = await callChatCompletion(modelConfig, resolvedModel, content, rule.prompt);

  return {
    ruleId: rule.id,
    ruleName: rule.name,
    model: resolvedModel,
    stage: 'audit',
    ...parseAuditResponse(fullResponse),
  };
}

function aggregateResults(ruleResults: InternalRuleResult[]): ParsedAuditResult {
  if (ruleResults.length === 0) {
    return { conclusion: '待人工复核', violations: [], analysis: '无审核规则。' };
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

    analyses.push(`【${ruleResult.ruleName}】模型: ${ruleResult.model}\n${ruleResult.analysis}`);
  }

  return {
    conclusion: hasViolation ? '违规' : allCompliant ? '合规' : '待人工复核',
    violations: allViolations,
    analysis: analyses.join('\n\n---\n\n'),
  };
}

export async function runAudit(
  content: ScrapedContent,
  rules?: AuditRules,
  modelConfig?: ModelApiConfig | null,
  preScreening?: MatchedRulesResult
): Promise<{
  result: ParsedAuditResult;
  ruleResults: RuleAuditResult[];
  screeningLabel?: string;
  adultConclusion?: string;
  matchedRuleNames?: string[];
}> {
  const productName = content.productName?.trim() || content.title?.trim() || '';
  const pageIssue = detectAdultPageIssue(content, productName);

  if (pageIssue) {
    const pageIssueConclusion =
      pageIssue.conclusion === '产品通过'
        ? '合规'
        : pageIssue.conclusion === '淫秽产品违规'
          ? '违规'
          : pageIssue.conclusion === '无需处理'
            ? '未审核'
            : '待人工复核';

    return {
      result: {
        conclusion: pageIssueConclusion,
        violations: [],
        analysis: pageIssue.analysis,
      },
      ruleResults: [
        {
          ruleId: 'adult-page-state',
          ruleName: '页面状态校验',
          model: 'system',
          conclusion: pageIssue.conclusion,
          violations: [],
          analysis: pageIssue.analysis,
          stage: 'system',
        },
      ],
      screeningLabel: '页面异常',
      adultConclusion: pageIssue.conclusion,
      matchedRuleNames: [],
    };
  }

  const enabledRules = rules?.rules?.filter((rule) => rule.enabled) || [];

  if (enabledRules.length === 0) {
    return {
      result: {
        conclusion: '未审核',
        violations: [],
        analysis: '未启用任何审核规则，请先在规则配置中启用至少一条规则。',
      },
      ruleResults: [],
      screeningLabel: '未启用规则',
      adultConclusion: '未审核',
      matchedRuleNames: [],
    };
  }

  const matched = preScreening || (await matchRulesByIntent(content, enabledRules, modelConfig));
  if (matched.matchedRules.length === 0) {
    return {
      result: {
        conclusion: '未审核',
        violations: [],
        analysis: `规则意图识别未命中任何已启用规则，本条链接已跳过内容审核。\n\n${matched.analysis}`,
      },
      ruleResults: matched.ruleResults,
      screeningLabel: '未命中规则',
      adultConclusion: '未审核',
      matchedRuleNames: [],
    };
  }

  const internalRuleResults: InternalRuleResult[] = [];
  const concurrency = 2;
  let ruleIndex = 0;

  async function processNextRule() {
    while (ruleIndex < matched.matchedRules.length) {
      const currentIndex = ruleIndex;
      ruleIndex += 1;
      internalRuleResults.push(await auditWithRule(content, matched.matchedRules[currentIndex], modelConfig));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, matched.matchedRules.length) }, () => processNextRule())
  );

  const aggregated = aggregateResults(internalRuleResults);

  return {
    result: {
      ...aggregated,
      analysis: `规则意图识别命中：${matched.matchedRules.map((rule) => rule.name).join('、')}\n\n${matched.analysis}\n\n${aggregated.analysis}`,
    },
    ruleResults: [
      ...matched.ruleResults,
      ...internalRuleResults.map((item) => ({
        ruleId: item.ruleId,
        ruleName: item.ruleName,
        model: item.model,
        conclusion: item.conclusion,
        violations: item.violations,
        analysis: item.analysis,
        stage: item.stage,
      })),
    ],
    screeningLabel: `命中 ${matched.matchedRules.length} 条规则`,
    adultConclusion: aggregated.conclusion,
    matchedRuleNames: matched.matchedRules.map((rule) => rule.name),
  };
}
