import { promises as fs } from 'fs';
import * as XLSX from 'xlsx';
import {
  ADULT_PREFERRED_EXCEL_COLUMN_ALIASES,
  ADULT_PREFERRED_EXCEL_COLUMNS,
  ADULT_REQUIRED_EXCEL_COLUMN_ALIASES,
  ADULT_REQUIRED_EXCEL_COLUMNS,
  buildAdultFetchFallback,
  getAdultConclusionStatus,
} from '@/lib/adult-audit';
import { createFeishuRecordWriter } from '@/lib/feishu-service';
import { runAudit, screenAuditRulesByProductName } from '@/lib/audit-service';
import { readBatchJobConfig, readBatchJobState, writeBatchJobState } from '@/lib/batch-job';
import type { AuditResult, BatchJobState, ProductLink, ScrapedContent } from '@/lib/types';

const BATCH_AUDIT_CONCURRENCY = 3;

function normalizeUrlInput(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const withProtocol =
    trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function findHeaderByAliases(headers: string[], aliases: readonly string[]) {
  return (
    headers.find((header) => {
      const normalizedHeader = header.toLowerCase().trim();
      return aliases.some((alias) => normalizedHeader === alias.toLowerCase().trim());
    }) || null
  );
}

function isProductNameEligible(name: string) {
  const normalized = name.trim();
  if (!normalized) return false;
  if (normalized.length < 2) return false;

  const blacklist = ['test', '测试', 'sample', 'demo', 'null', 'n/a', '未知', '未命名', '商品', '产品'];
  const lower = normalized.toLowerCase();
  if (blacklist.some((item) => lower === item || lower.includes(item))) return false;

  return /[\u4e00-\u9fa5a-zA-Z0-9]{2,}/.test(normalized);
}

function updateState(state: BatchJobState, patch: Partial<BatchJobState>): BatchJobState {
  return {
    ...state,
    ...patch,
    progress: {
      ...state.progress,
      ...(patch.progress || {}),
    },
  };
}

function createLimiter(concurrency: number) {
  const safeConcurrency = Math.max(1, concurrency);
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const releaseNext = () => {
    activeCount -= 1;
    const nextTask = queue.shift();
    nextTask?.();
  };

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (activeCount >= safeConcurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }

    activeCount += 1;
    try {
      return await task();
    } finally {
      releaseNext();
    }
  };
}

async function postJson<T>(url: string, payload: unknown) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`接口返回了无法解析的内容：${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    const error = (data as { error?: string }).error || `HTTP ${response.status}`;
    throw new Error(error);
  }

  return data;
}

function mapRawRowToProductLink(
  row: Record<string, unknown>,
  detectedColumns: { url?: string | null; name?: string | null; sku?: string | null; platform?: string | null },
  index: number
): ProductLink | null {
  const urlValue = detectedColumns.url ? String(row[detectedColumns.url] || '').trim() : '';
  const url = normalizeUrlInput(urlValue);
  if (!url) return null;

  return {
    id: `batch_link_${Date.now()}_${index}`,
    url,
    name: detectedColumns.name ? String(row[detectedColumns.name] || '').trim() : '',
    sku: detectedColumns.sku ? String(row[detectedColumns.sku] || '').trim() : '',
    platform: detectedColumns.platform ? String(row[detectedColumns.platform] || '').trim() : '',
    rawRow: row,
    status: 'pending',
  };
}

async function parseExcelFile(filePath: string) {
  const buffer = await fs.readFile(filePath);
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error('Excel 文件中没有工作表');
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: '' });
  if (!rows.length) {
    throw new Error('Excel 文件中没有数据');
  }

  const headers = Object.keys(rows[0]);
  const missingRequiredColumns = ADULT_REQUIRED_EXCEL_COLUMNS.filter((column, index) => {
    if (headers.includes(column)) return false;
    const aliases = ADULT_REQUIRED_EXCEL_COLUMN_ALIASES[index] || [column];
    return !findHeaderByAliases(headers, aliases);
  });
  if (missingRequiredColumns.length > 0) {
    throw new Error(`Excel 缺少必填列：${missingRequiredColumns.join('、')}`);
  }
  const exactUrlColumnKeys = [
    ...ADULT_REQUIRED_EXCEL_COLUMNS,
    '产品链接',
    '第三方域名链接',
    '链接',
    'url',
    'link',
    '网址',
  ];
  const preferredUrlColumnKeys = [
    '产品url',
    'product_url',
    'product_link',
    'landing_page_url',
    'landing url',
    'landing page',
  ];
  const discouragedUrlColumnKeys = ['帖子链接', '帖子url', 'post_url', 'post link', 'facebook链接'];
  const normalizedHeaders = headers.map((header) => ({
    original: header,
    normalized: header.toLowerCase().trim(),
  }));

  const exactUrlKey =
    normalizedHeaders.find(({ normalized }) =>
      exactUrlColumnKeys.some((item) => normalized === item.toLowerCase())
    )?.original || null;

  const preferredUrlKey =
    normalizedHeaders.find(({ normalized }) =>
      preferredUrlColumnKeys.some(
        (item) => normalized === item.toLowerCase() || normalized.includes(item.toLowerCase())
      )
    )?.original || null;

  const fallbackCandidates = normalizedHeaders
    .map(({ original, normalized }) => {
      if (
        discouragedUrlColumnKeys.some(
          (item) => normalized === item.toLowerCase() || normalized.includes(item.toLowerCase())
        )
      ) {
        return { original, validCount: -1 };
      }

      const validCount = rows.reduce((count, row) => {
        const candidate = normalizeUrlInput(String(row[original] || ''));
        return candidate ? count + 1 : count;
      }, 0);

      return { original, validCount };
    })
    .filter((item) => item.validCount > 0)
    .sort((left, right) => right.validCount - left.validCount);

  const fallbackUrlKey = fallbackCandidates[0]?.original || null;
  const urlKey = exactUrlKey || preferredUrlKey || fallbackUrlKey;

  if (!urlKey) {
    throw new Error('未找到链接列，请确保 Excel 中包含 url / 链接 / 产品链接 等字段');
  }

  const nameKey = findHeaderByAliases(headers, ADULT_REQUIRED_EXCEL_COLUMN_ALIASES[0]);
  const skuKey = findHeaderByAliases(headers, ADULT_PREFERRED_EXCEL_COLUMN_ALIASES['虚拟SKU编号']);
  const platformKey = findHeaderByAliases(headers, ADULT_PREFERRED_EXCEL_COLUMN_ALIASES['部门']);

  return {
    rows,
      detectedColumns: {
        url: urlKey,
        name: nameKey || null,
        sku: skuKey || null,
        platform: platformKey || null,
        preferred: ADULT_PREFERRED_EXCEL_COLUMNS.filter((column) => headers.includes(column)),
      },
    };
}

async function fetchScrapedContent(serverBaseUrl: string, url: string) {
  return postJson<{ success?: boolean; error?: string; content?: ScrapedContent; statusCode?: number }>(
    `${serverBaseUrl}/api/fetch`,
    { url }
  );
}

function mapAuditStatus(conclusion: string) {
  if (conclusion === '产品通过') return 'passed' as const;
  if (conclusion === '淫秽产品违规') return 'violated' as const;
  if (conclusion === '无需处理') return 'unaudited' as const;
  if (conclusion === '需人工处理') return 'review' as const;
  if (conclusion === '合规') return 'passed' as const;
  if (conclusion === '违规') return 'violated' as const;
  if (conclusion === '未审核') return 'unaudited' as const;
  return 'review' as const;
}

function createBatchAuditResult(
  link: ProductLink,
  options: {
    conclusion: string;
    status: AuditResult['status'];
    analysis: string;
    scrapedContent?: ScrapedContent;
    ruleResults?: AuditResult['ruleResults'];
    violations?: AuditResult['violations'];
    errorMessage?: string;
  }
): AuditResult {
  return {
    id: link.id,
    productLink: link,
    conclusion: options.conclusion,
    status: options.status,
    analysis: options.analysis,
    auditDetail: options.analysis,
    scrapedContent: options.scrapedContent,
    ruleResults: options.ruleResults,
    violations: options.violations || [],
    errorMessage: options.errorMessage,
    timestamp: Date.now(),
  };
}

export async function runBatchJob(jobId: string) {
  const config = await readBatchJobConfig(jobId);
  let state = await readBatchJobState(jobId);

  try {
    state = updateState(state, {
      phase: 'running',
      step: 'initializing',
      message: '后台批量审核任务启动中...',
      startedAt: Date.now(),
    });
    await writeBatchJobState(state);

    const { rows, detectedColumns } = await parseExcelFile(config.filePath);
    state = updateState(state, {
      step: 'deduplicating',
      message: '正在对 Excel 数据去重...',
      progress: {
        ...state.progress,
        totalRows: rows.length,
      },
    });
    await writeBatchJobState(state);

    const seenUrls = new Set<string>();
    const deduplicatedLinks: ProductLink[] = [];

    rows.forEach((row, index) => {
      const link = mapRawRowToProductLink(row, detectedColumns, index);
      if (!link) return;
      if (seenUrls.has(link.url)) return;
      seenUrls.add(link.url);
      deduplicatedLinks.push(link);
    });

    state = updateState(state, {
      step: 'intent-matching',
      message: '正在做商品名基础清洗，规则级筛选将在正式审核前执行...',
      progress: {
        ...state.progress,
        deduplicatedRows: deduplicatedLinks.length,
      },
    });
    await writeBatchJobState(state);

    const eligibleLinks: ProductLink[] = [];
    const skippedLinks: ProductLink[] = [];
    const shouldFilterByProductName = Boolean(detectedColumns.name);
    let skippedRows = 0;
    for (const link of deduplicatedLinks) {
      if (shouldFilterByProductName && !isProductNameEligible(link.name || '')) {
        skippedRows += 1;
        skippedLinks.push(link);
        continue;
      }
      eligibleLinks.push(link);
    }

    state = updateState(state, {
      step: 'preparing-feishu',
      message: '正在校验飞书授权和目标多维表配置...',
      progress: {
        ...state.progress,
        eligibleRows: eligibleLinks.length,
        skippedRows,
      },
    });
    await writeBatchJobState(state);

    const recordWriter = await createFeishuRecordWriter(config.feishuConfig);

    state = updateState(state, {
      step: 'auditing',
      message: `正在并发抓取内容、执行 AI 审核并实时写回飞书（并发 ${BATCH_AUDIT_CONCURRENCY}）...`,
      bitableUrl: recordWriter.config.bitableUrl,
      appToken: recordWriter.config.appToken,
      tableId: recordWriter.config.tableId,
    });
    await writeBatchJobState(state);

    if (skippedLinks.length > 0) {
      await Promise.all(
        skippedLinks.map(async (link) => {
          const skippedResult = createBatchAuditResult(link, {
            conclusion: '非审核目标',
            status: 'unaudited',
            analysis: shouldFilterByProductName
              ? `产品名称“${link.name || '空值'}”不符合当前审核目标的意图识别规则，已跳过审核。`
              : '当前记录不属于审核目标，已跳过审核。',
          });

          try {
            await recordWriter.pushResult(skippedResult);
          } catch (error) {
            console.error('[batch-job] skipped row push failed', {
              jobId,
              url: link.url,
              error,
            });
          }
        })
      );
    }

    const limit = createLimiter(BATCH_AUDIT_CONCURRENCY);
    let processedRows = 0;
    let successRows = 0;
    let failedRows = 0;
    let progressWriteChain = Promise.resolve();

    const queueProgressWrite = (message: string) => {
      progressWriteChain = progressWriteChain.then(async () => {
        state = updateState(state, {
          message,
          progress: {
            ...state.progress,
            processedRows,
            successRows,
            failedRows,
          },
        });
        await writeBatchJobState(state);
      });

      return progressWriteChain;
    };

    await Promise.all(
      eligibleLinks.map((link, index) =>
        limit(async () => {
          let rowFailed = false;
          let scrapedContent: ScrapedContent | undefined;
          try {
            const fetchData = await fetchScrapedContent(config.serverBaseUrl, link.url);
            if (fetchData.error || !fetchData.content) {
              const fallback = buildAdultFetchFallback(fetchData.statusCode, fetchData.error);
              const result = createBatchAuditResult(link, {
                conclusion: fallback.conclusion,
                status: getAdultConclusionStatus(fallback.conclusion),
                analysis: fallback.analysis,
                scrapedContent: fetchData.content,
              });
              await recordWriter.pushResult(result);
              successRows += 1;
              return;
            }
            scrapedContent = fetchData.content;
            scrapedContent.productName = link.name || fetchData.content.title;

            if (!scrapedContent) {
              throw new Error('网页抓取结果为空');
            }

            const preScreening = await screenAuditRulesByProductName(
              link.name || scrapedContent.productName || scrapedContent.title || '',
              config.rules,
              config.modelConfig
            );

            if (preScreening.matchedRules.length === 0) {
              const result = createBatchAuditResult(link, {
                conclusion: '未审核',
                status: 'unaudited',
                analysis: `规则级商品名筛选未命中任何已启用规则，本条链接已跳过页面审核。\n\n${preScreening.analysis}`,
                scrapedContent,
                ruleResults: [
                  {
                    ruleId: 'rule-name-screening',
                    ruleName: '规则级商品名筛选',
                    model: 'system',
                    conclusion: '未命中',
                    violations: [],
                    analysis: preScreening.analysis,
                  },
                ],
              });
              result.screeningLabel = '未命中规则';
              result.adultConclusion = '未审核';
              result.matchedRuleNames = [];
              await recordWriter.pushResult(result);
              successRows += 1;
              return;
            }

            const auditData = await runAudit(
              scrapedContent,
              config.rules,
              config.modelConfig,
              preScreening
            );
            const result = createBatchAuditResult(link, {
              conclusion: auditData.adultConclusion || auditData.result.conclusion,
              status: mapAuditStatus(auditData.adultConclusion || auditData.result.conclusion),
              analysis: auditData.result.analysis,
              scrapedContent,
              ruleResults: auditData.ruleResults,
              violations: auditData.result.violations,
            });
            result.screeningLabel = auditData.screeningLabel;
            result.adultConclusion = auditData.adultConclusion;
            result.matchedRuleNames = auditData.matchedRuleNames;

            await recordWriter.pushResult(result);
            successRows += 1;
          } catch (error) {
            rowFailed = true;
            failedRows += 1;
            console.error('[batch-job] row failed', { jobId, url: link.url, error });

            const reason = error instanceof Error ? error.message : '处理失败';
            const failedResult = createBatchAuditResult(link, {
              conclusion: reason,
              status: 'error',
              analysis: `链接处理失败：${reason}`,
              scrapedContent,
              errorMessage: reason,
            });

            try {
              await recordWriter.pushResult(failedResult);
            } catch (pushError) {
              console.error('[batch-job] failed row push failed', {
                jobId,
                url: link.url,
                error: pushError,
              });

               try {
                 const fallbackFailedResult = createBatchAuditResult(link, {
                   conclusion: reason.slice(0, 200),
                   status: 'error',
                   analysis: `链接处理失败：${reason}`.slice(0, 1000),
                   errorMessage: reason,
                 });
                 await recordWriter.pushResult(fallbackFailedResult);
               } catch (fallbackPushError) {
                 console.error('[batch-job] failed row fallback push failed', {
                   jobId,
                   url: link.url,
                   error: fallbackPushError,
                 });
               }
            }
          } finally {
            processedRows += 1;
            const message =
              rowFailed
                ? `第 ${index + 1}/${eligibleLinks.length} 条处理失败，继续后续任务...`
                : `已完成 ${processedRows}/${eligibleLinks.length} 条，正在持续写回飞书...`;
            await queueProgressWrite(message);
          }
        })
      )
    );

    await progressWriteChain;

    state = updateState(state, {
      phase: 'completed',
      step: 'completed',
      message: '后台批量审核任务已完成。',
      finishedAt: Date.now(),
      progress: {
        ...state.progress,
        processedRows,
        successRows,
        failedRows,
      },
    });
    await writeBatchJobState(state);
  } catch (error) {
    state = updateState(state, {
      phase: 'failed',
      step: 'failed',
      message: '后台批量审核任务执行失败。',
      finishedAt: Date.now(),
      error: error instanceof Error ? error.message : '后台批量审核任务执行失败',
    });
    await writeBatchJobState(state);
    throw error;
  }
}
