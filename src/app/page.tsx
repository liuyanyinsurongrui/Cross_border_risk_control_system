'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Play, SendHorizontal, Shield, TerminalSquare, Globe } from 'lucide-react';
import { BatchModePanel } from '@/components/audit/batch-mode-panel';
import { ContentPreview } from '@/components/audit/content-preview';
import { FeishuConfigDialog } from '@/components/audit/feishu-config-dialog';
import { LinkList } from '@/components/audit/link-list';
import { ModelConfigDialog } from '@/components/audit/model-config-dialog';
import { ResultPanel } from '@/components/audit/result-panel';
import { RulesConfig, DEFAULT_AUDIT_RULES } from '@/components/audit/rules-config';
import { StatsBar } from '@/components/audit/stats-bar';
import { UploadZone } from '@/components/audit/upload-zone';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { buildAdultFetchFallback, getAdultConclusionStatus } from '@/lib/adult-audit';
import type {
  AuditMode,
  AuditResult,
  AuditRules,
  FeishuConfig,
  ModelApiConfig,
  ModelOption,
  ProductLink,
  ScrapedContent,
} from '@/lib/types';

const RULES_STORAGE_KEY = 'audit_rules_config';

function mergeRulesWithDefaults(rules: AuditRules): AuditRules {
  const defaultRuleMap = new Map(DEFAULT_AUDIT_RULES.map((rule) => [rule.id, rule]));

  return {
    rules: rules.rules.map((rule) => {
      const defaultRule = defaultRuleMap.get(rule.id);
      if (!defaultRule) return { ...rule };

      return {
        ...defaultRule,
        ...rule,
        screeningPrompt: rule.screeningPrompt?.trim() ? rule.screeningPrompt : defaultRule.screeningPrompt,
        prompt: rule.prompt?.trim() ? rule.prompt : defaultRule.prompt,
      };
    }),
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

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const responseText = await response.text();

  try {
    return JSON.parse(responseText) as T;
  } catch {
    if (responseText.startsWith('<!DOCTYPE') || responseText.startsWith('<html')) {
      throw new Error('接口返回了 HTML 页面，通常是服务异常或编译失败。');
    }

    throw new Error(`接口返回了无法解析的内容：${responseText.slice(0, 120)}`);
  }
}

function getFetchErrorMessage(statusCode?: number, fallback?: string) {
  if (!statusCode) return fallback || '网页抓取失败';
  if (statusCode === 403) return '网页不可访问（HTTP 403）';
  if (statusCode === 404) return '网页不存在（HTTP 404）';
  return `网页状态异常（HTTP ${statusCode}）`;
}

export default function AuditPage() {
  const { toast } = useToast();
  const [mode, setMode] = useState<AuditMode>('web');
  const [results, setResults] = useState<AuditResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isAuditing, setIsAuditing] = useState(false);
  const [isPushing, setIsPushing] = useState(false);
  const [feishuConfig, setFeishuConfig] = useState<FeishuConfig | null>(null);
  const [modelConfig, setModelConfig] = useState<ModelApiConfig | null>(null);
  const [rules, setRules] = useState<AuditRules>({
    rules: DEFAULT_AUDIT_RULES.map((rule) => ({ ...rule })),
  });
  const [rulesHydrated, setRulesHydrated] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(RULES_STORAGE_KEY);
      if (!saved) {
        setRulesHydrated(true);
        return;
      }

      const parsed = JSON.parse(saved) as AuditRules;
      if (Array.isArray(parsed?.rules) && parsed.rules.length > 0) {
        setRules(
          mergeRulesWithDefaults({
            rules: parsed.rules.map((rule) => ({ ...rule })),
          })
        );
      }
    } catch {
      // ignore invalid saved rules
    } finally {
      setRulesHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!rulesHydrated) return;

    try {
      localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(rules));
    } catch {
      // ignore
    }
  }, [rules, rulesHydrated]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const url = new URL(window.location.href);
    if (url.searchParams.get('feishu_oauth') !== '1') return;

    const payload = {
      type: 'feishu-oauth-result' as const,
      code: url.searchParams.get('code') || '',
      state: url.searchParams.get('state') || '',
      error: url.searchParams.get('error') || '',
      errorDescription: url.searchParams.get('error_description') || '',
    };

    try {
      localStorage.setItem('audit_feishu_oauth_result', JSON.stringify(payload));
    } catch {
      // ignore
    }

    try {
      window.opener?.postMessage(payload, window.location.origin);
    } catch {
      // ignore
    }

    window.history.replaceState({}, '', '/');
    if (window.opener) {
      window.setTimeout(() => window.close(), 300);
    }
  }, []);

  const modelOptions = useMemo<ModelOption[]>(() => {
    if (!modelConfig?.apiKey.trim()) return [];

    if (modelConfig.provider === 'ark') {
      const endpointId = modelConfig.endpointId.trim();
      if (!endpointId) return [];

      return [
        {
          id: endpointId,
          name: `方舟接入点：${endpointId}`,
          supportsImage: true,
        },
      ];
    }

    if (modelConfig.provider === 'openai-compatible') {
      const modelName = modelConfig.modelName.trim();
      if (!modelName || !modelConfig.modelBaseUrl.trim()) return [];

      return [
        {
          id: modelName,
          name: modelName,
          supportsImage: true,
        },
      ];
    }

    return [];
  }, [modelConfig]);

  useEffect(() => {
    setRules((prev) => {
      const allowedModelIds = new Set(modelOptions.map((option) => option.id));
      const fallbackModelId = modelOptions[0]?.id ?? '';
      let hasChanged = false;

      const nextRules = prev.rules.map((rule) => {
        if (allowedModelIds.size === 0) {
          if (rule.model !== '') {
            hasChanged = true;
            return { ...rule, model: '' };
          }
          return rule;
        }

        if (!allowedModelIds.has(rule.model)) {
          hasChanged = true;
          return { ...rule, model: fallbackModelId };
        }

        return rule;
      });

      return hasChanged ? { ...prev, rules: nextRules } : prev;
    });
  }, [modelOptions]);

  const selectedResult = selectedIndex !== null ? results[selectedIndex] : null;

  const handleLinksAdded = useCallback(
    (newLinks: ProductLink[]) => {
      setResults((prev) => {
        const updated = [...prev];

        for (const link of newLinks) {
          const existingIndex = updated.findIndex((item) => item.productLink.url === link.url);
          if (existingIndex >= 0) {
            if (updated[existingIndex].status !== 'pending') {
              updated[existingIndex] = {
                ...updated[existingIndex],
                productLink: link,
                status: 'pending',
                conclusion: '未审核',
                violations: [],
                analysis: '',
                scrapedContent: undefined,
                auditDetail: undefined,
                errorMessage: undefined,
                ruleResults: undefined,
              };
            }
            continue;
          }

          updated.push({
            id: link.id,
            productLink: link,
            status: 'pending',
            conclusion: '未审核',
            violations: [],
            analysis: '',
            timestamp: Date.now(),
          });
        }

        return updated;
      });

      setSelectedIndex(0);
      toast({
        title: '链接已添加',
        description: newLinks.length > 1 ? `共新增 ${newLinks.length} 条链接` : '已新增 1 条链接',
      });
    },
    [toast]
  );

  const updateResult = useCallback((id: string, updates: Partial<AuditResult>) => {
    setResults((prev) => prev.map((item) => (item.id === id ? { ...item, ...updates } : item)));
  }, []);

  const fetchContentForResult = useCallback(
    async (result: AuditResult) => {
      try {
        updateResult(result.id, { status: 'scraping' });

        const response = await fetch('/api/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: result.productLink.url }),
        });

        const data = await parseJsonResponse<{
          success?: boolean;
          error?: string;
          content?: ScrapedContent;
          statusCode?: number;
          pageState?: string;
        }>(response);

        if (!response.ok || data.error || !data.content) {
          const fallback = buildAdultFetchFallback(data.statusCode, data.error);
          updateResult(result.id, {
            status: getAdultConclusionStatus(fallback.conclusion),
            conclusion:
              fallback.conclusion === '淫秽产品违规'
                ? '违规'
                : fallback.conclusion === '产品通过'
                  ? '合规'
                  : fallback.conclusion === '无需处理'
                    ? '未审核'
                    : '待人工复核',
            adultConclusion: fallback.conclusion,
            analysis: fallback.analysis,
            auditDetail: fallback.analysis,
            errorMessage: getFetchErrorMessage(data.statusCode, data.error),
            scrapedContent: data.content,
          });
          return null;
        }

        const enrichedContent = {
          ...data.content,
          productName: result.productLink.name || data.content.title,
        };

        updateResult(result.id, { status: 'fetched', scrapedContent: enrichedContent });
        return enrichedContent;
      } catch (error) {
        updateResult(result.id, {
          status: 'error',
          errorMessage: error instanceof Error ? error.message : '抓取过程中发生错误',
        });
        return null;
      }
    },
    [updateResult]
  );

  const auditScrapedContent = useCallback(
    async (result: AuditResult, scrapedContent: ScrapedContent) => {
      try {
        updateResult(result.id, { status: 'auditing', scrapedContent });

        const response = await fetch('/api/audit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: scrapedContent, rules, modelConfig }),
        });

        const data = await parseJsonResponse<{
          error?: string;
          rawResponse?: string;
          ruleResults?: AuditResult['ruleResults'];
          screeningLabel?: string;
          adultConclusion?: string;
          matchedRuleNames?: string[];
          result?: {
            conclusion?: string;
            violations?: AuditResult['violations'];
            analysis?: string;
          };
        }>(response);

        if (!response.ok || data.error || !data.result) {
          updateResult(result.id, {
            status: 'error',
            errorMessage: data.error || 'AI 审核失败',
          });
          return;
        }

        const allowedConclusions = new Set(['合规', '违规', '待人工复核', '未审核']);
        const conclusion = allowedConclusions.has(data.result.conclusion || '')
          ? (data.result.conclusion as AuditResult['conclusion'])
          : '待人工复核';

        const status =
          conclusion === '合规'
            ? 'passed'
            : conclusion === '违规'
              ? 'violated'
              : conclusion === '未审核'
                ? 'unaudited'
                : 'review';

        updateResult(result.id, {
          status,
          conclusion,
          adultConclusion: data.adultConclusion,
          screeningLabel: data.screeningLabel,
          matchedRuleNames: data.matchedRuleNames,
          violations: data.result.violations || [],
          analysis: data.result.analysis || '',
          auditDetail: data.result.analysis || data.rawResponse || '',
          ruleResults: data.ruleResults || [],
        });
      } catch (error) {
        updateResult(result.id, {
          status: 'error',
          errorMessage: error instanceof Error ? error.message : '审核过程中发生错误',
        });
      }
    },
    [modelConfig, rules, updateResult]
  );

  const handleBatchAudit = useCallback(async () => {
    if (modelOptions.length === 0) {
      toast({
        title: '请先配置模型',
        description: '完成模型配置后，规则中的可选模型才会出现。',
        variant: 'destructive',
      });
      return;
    }

    const pendingResults = results.filter(
      (item) => item.status === 'pending' || item.status === 'error'
    );

    if (pendingResults.length === 0) {
      toast({
        title: '没有待审核链接',
        description: '当前链接都已经处理完成。',
      });
      return;
    }

    setIsAuditing(true);

    const fetchConcurrency = Math.min(8, pendingResults.length);
    const auditConcurrency = Math.min(3, pendingResults.length);
    const limitFetch = createLimiter(fetchConcurrency);
    const limitAudit = createLimiter(auditConcurrency);
    const auditTasks: Promise<void>[] = [];

    toast({
      title: '开始批量审核',
      description: `共 ${pendingResults.length} 条，先抓取文字与图片，再进入 AI 审核。抓取并发 ${fetchConcurrency}，审核并发 ${auditConcurrency}`,
    });

    await Promise.all(
      pendingResults.map((result) =>
        limitFetch(async () => {
          const scrapedContent = await fetchContentForResult(result);
          if (!scrapedContent) return;
          auditTasks.push(limitAudit(() => auditScrapedContent(result, scrapedContent)));
        })
      )
    );

    if (auditTasks.length > 0) {
      toast({
        title: '抓取完成，开始审核',
        description: `已完成内容抓取，正在执行 ${auditTasks.length} 条 AI 审核任务`,
      });
    }

    await Promise.all(auditTasks);

    setIsAuditing(false);
    toast({
      title: '批量审核完成',
      description: `${pendingResults.length} 条链接已处理完成`,
    });
  }, [auditScrapedContent, fetchContentForResult, modelOptions.length, results, toast]);

  const handlePushFeishu = useCallback(async () => {
    if (
      !feishuConfig?.appId ||
      !feishuConfig?.appSecret ||
      !feishuConfig?.appToken ||
      !feishuConfig?.tableId
    ) {
      toast({
        title: '请先配置飞书',
        description: '请先在右上角完成飞书配置。',
        variant: 'destructive',
      });
      return;
    }

    const completedResults = results.filter(
      (item) => item.status === 'passed' || item.status === 'violated'
    );

    if (completedResults.length === 0) {
      toast({
        title: '没有可推送结果',
        description: '请先完成审核。',
      });
      return;
    }

    setIsPushing(true);
    try {
      const response = await fetch('/api/feishu', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: feishuConfig, results: completedResults }),
      });

      const data = await parseJsonResponse<{
        error?: string;
        updatedConfig?: FeishuConfig;
        details?: Array<{ success: boolean; error?: string }>;
        failCount?: number;
        successCount?: number;
      }>(response);

      if (!response.ok || data.error) {
        toast({
          title: '推送失败',
          description: data.error || '未知错误',
          variant: 'destructive',
        });
        return;
      }

      if (data.updatedConfig) {
        setFeishuConfig(data.updatedConfig);
        try {
          localStorage.setItem('audit_feishu_config', JSON.stringify(data.updatedConfig));
        } catch {
          // ignore
        }
      }

      const failedDetails =
        data.details?.filter((item: { success: boolean }) => !item.success) || [];
      const failCount = data.failCount ?? 0;
      const successCount = data.successCount ?? 0;

      if (failCount > 0 && failedDetails.length > 0) {
        const firstError = failedDetails[0].error || '未知错误';
        toast({
          title: '部分推送失败',
          description: `成功 ${successCount} 条，失败 ${failCount} 条。首条错误：${firstError}`,
          variant: 'destructive',
        });
        return;
      }

      toast({
        title: '推送完成',
        description: `成功推送 ${successCount} 条结果`,
      });
    } catch (error) {
      toast({
        title: '推送失败',
        description: error instanceof Error ? error.message : '推送失败',
        variant: 'destructive',
      });
    } finally {
      setIsPushing(false);
    }
  }, [feishuConfig, results, toast]);

  const hasResults = results.length > 0;
  const hasCompleted = results.some(
    (item) => item.status === 'passed' || item.status === 'violated'
  );
  const isProcessing = results.some(
    (item) => item.status === 'scraping' || item.status === 'auditing'
  );

  return (
    <div className="min-h-screen bg-[#0f1117]">
      <header className="sticky top-0 z-50 border-b border-slate-800 bg-[#0f1117]/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Shield className="h-6 w-6 text-emerald-400" />
            <h1 className="text-base font-semibold text-slate-200">跨境合规审核</h1>
            <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
              AI POWERED
            </span>
          </div>

          <div className="flex items-center gap-3">
            <ModelConfigDialog config={modelConfig} onSave={setModelConfig} />
            <FeishuConfigDialog config={feishuConfig} onSave={setFeishuConfig} />
          </div>
        </div>
      </header>

      <div className="border-b border-slate-800 bg-[#0f1117]">
        <div className="mx-auto max-w-[1440px] px-6 py-4">
          <StatsBar results={results} />
        </div>
      </div>

      <div className="border-b border-slate-800/50 bg-[#12141c]">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant={mode === 'web' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('web')}
              className={mode === 'web' ? 'bg-emerald-600 hover:bg-emerald-700' : 'border-slate-600 text-slate-300'}
            >
              <Globe className="mr-1.5 h-3.5 w-3.5" />
              网页审核
            </Button>
            <Button
              variant={mode === 'cmd' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('cmd')}
              className={mode === 'cmd' ? 'bg-cyan-600 hover:bg-cyan-700' : 'border-slate-600 text-slate-300'}
            >
              <TerminalSquare className="mr-1.5 h-3.5 w-3.5" />
              CMD 后台批量审核
            </Button>
          </div>

          {mode === 'web' && (
            <div className="flex gap-2">
              <Button
                onClick={handleBatchAudit}
                disabled={!hasResults || isAuditing || isProcessing}
                className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                size="sm"
              >
                {isAuditing || isProcessing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {isAuditing || isProcessing ? '处理中...' : '开始审核'}
              </Button>

              <Button
                onClick={handlePushFeishu}
                disabled={!hasCompleted || isPushing}
                variant="outline"
                size="sm"
                className="gap-2 border-slate-600 text-slate-300 hover:bg-slate-800"
              >
                {isPushing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <SendHorizontal className="h-3.5 w-3.5" />
                )}
                推送飞书
              </Button>
            </div>
          )}
        </div>
      </div>

      <main className="mx-auto max-w-[1440px] px-6 py-6">
        {mode === 'cmd' ? (
          <div className="grid grid-cols-12 gap-5">
            <div className="col-span-6">
              <BatchModePanel
                modelConfig={modelConfig}
                feishuConfig={feishuConfig}
                rules={rules}
              />
            </div>
            <div className="col-span-6">
              <RulesConfig rules={rules} modelOptions={modelOptions} onChange={setRules} />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-12 gap-5">
            <div className="col-span-4 space-y-4">
              <UploadZone
                onLinksAdded={handleLinksAdded}
                isLoading={isUploading}
                setIsLoading={setIsUploading}
                existingUrls={results.map((item) => item.productLink.url)}
              />
              <LinkList results={results} selectedIndex={selectedIndex} onSelect={setSelectedIndex} />
              <RulesConfig rules={rules} modelOptions={modelOptions} onChange={setRules} />
            </div>

            <div className="col-span-4">
              <ContentPreview
                content={selectedResult?.scrapedContent}
                isLoading={
                  selectedResult?.status === 'scraping' || selectedResult?.status === 'auditing'
                }
              />
            </div>

            <div className="col-span-4">
              <ResultPanel result={selectedResult} />
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
