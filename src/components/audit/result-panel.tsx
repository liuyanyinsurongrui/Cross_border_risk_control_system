'use client';

import React, { useState } from 'react';
import {
  Shield,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Cpu,
  MinusCircle,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { AuditResult, RuleAuditResult, ViolationItem } from '@/lib/types';

interface ResultPanelProps {
  result: AuditResult | null;
}

function SeverityBadge({ severity }: { severity: ViolationItem['severity'] }) {
  const config = {
    high: { color: 'text-red-400 bg-red-500/10 border-red-500/20', label: '高' },
    medium: { color: 'text-yellow-400 bg-yellow-500/10 border-yellow-500/20', label: '中' },
    low: { color: 'text-blue-400 bg-blue-500/10 border-blue-500/20', label: '低' },
  };

  const current = config[severity];
  return (
    <Badge variant="outline" className={`border text-[10px] ${current.color}`}>
      {current.label}
    </Badge>
  );
}

function ViolationCard({ violation }: { violation: ViolationItem }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-md border border-slate-700 bg-slate-900/50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <div
            className={`mt-0.5 shrink-0 rounded p-0.5 ${
              violation.type === 'image' ? 'bg-purple-500/10' : 'bg-blue-500/10'
            }`}
          >
            <AlertTriangle
              className={`h-3 w-3 ${violation.type === 'image' ? 'text-purple-400' : 'text-blue-400'}`}
            />
          </div>
          <div>
            <p className="text-xs font-medium text-slate-300">{violation.category}</p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {violation.type === 'image' ? '图片违规' : '文字违规'}
            </p>
          </div>
        </div>
        <SeverityBadge severity={violation.severity} />
      </div>
      <p className="mt-2 text-xs text-slate-400">{violation.description}</p>
      {expanded && violation.evidence && (
        <div className="mt-2 rounded bg-slate-800 p-2">
          <p className="font-mono text-[11px] text-slate-500">{violation.evidence}</p>
        </div>
      )}
      {violation.evidence && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-400"
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {expanded ? '收起证据' : '查看证据'}
        </button>
      )}
    </div>
  );
}

export function ResultPanel({ result }: ResultPanelProps) {
  if (!result) {
    return (
      <Card className="border-border/50 bg-[#1a1d27]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Shield className="h-4 w-4 text-emerald-400" />
            审核结果
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-[200px] items-center justify-center text-sm text-slate-500">
            审核完成后，结果会显示在这里
          </div>
        </CardContent>
      </Card>
    );
  }

  if (result.status === 'scraping' || result.status === 'fetched' || result.status === 'auditing') {
    return (
      <Card className="border-border/50 bg-[#1a1d27]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Shield className="h-4 w-4 text-blue-400" />
            处理中
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-[200px] items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
              <p className="text-sm text-slate-500">
                {result.status === 'scraping'
                  ? '正在抓取文字与图片...'
                  : result.status === 'fetched'
                    ? '内容已抓取完成，等待 AI 审核...'
                    : 'AI 正在审核分析...'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (result.status === 'error') {
    return (
      <Card className="border-border/50 bg-[#1a1d27]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Shield className="h-4 w-4 text-red-400" />
            审核失败
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="rounded-md bg-red-500/10 p-4">
            <p className="text-sm text-red-400">{result.errorMessage || '审核过程中发生错误'}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const conclusionConfig = {
    合规: { icon: CheckCircle, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
    违规: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20' },
    待人工复核: {
      icon: AlertTriangle,
      color: 'text-yellow-400',
      bg: 'bg-yellow-500/10',
      border: 'border-yellow-500/20',
    },
    未审核: { icon: MinusCircle, color: 'text-slate-500', bg: 'bg-slate-500/10', border: 'border-slate-500/20' },
  };

  const current =
    conclusionConfig[result.conclusion as keyof typeof conclusionConfig] || conclusionConfig.待人工复核;
  const ConclusionIcon = current.icon;

  return (
    <Card className="border-border/50 bg-[#1a1d27]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <Shield className="h-4 w-4 text-emerald-400" />
          审核结果
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className={`flex items-center gap-3 rounded-lg border p-4 ${current.bg} ${current.border}`}>
          <ConclusionIcon className={`h-6 w-6 ${current.color}`} />
          <div>
            <p className={`text-lg font-semibold ${current.color}`}>{result.conclusion}</p>
            {result.adultConclusion && (
              <p className="mt-0.5 text-xs text-slate-300">成人审核结论：{result.adultConclusion}</p>
            )}
            {result.screeningLabel && (
              <p className="mt-0.5 text-xs text-amber-300">规则意图识别：{result.screeningLabel}</p>
            )}
            {result.matchedRuleNames && result.matchedRuleNames.length > 0 && (
              <p className="mt-0.5 text-xs text-cyan-300">
                命中规则：{result.matchedRuleNames.join('、')}
              </p>
            )}
            <p className="text-xs text-slate-400">
              {result.conclusion === '未审核'
                ? '当前未启用审核规则，暂未调用模型判断'
                : `发现 ${result.violations.length} 个违规项`}
            </p>
          </div>
        </div>

        {result.violations.length > 0 && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-slate-400">违规详情</h3>
            <div className="space-y-2">
              {result.violations.map((violation, index) => (
                <ViolationCard key={index} violation={violation} />
              ))}
            </div>
          </div>
        )}

        {result.auditDetail && (
          <div>
            <h3 className="mb-2 text-xs font-medium text-slate-400">AI 审核分析</h3>
            <ScrollArea className="h-[150px] rounded-md bg-slate-900/50 p-3">
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
                {result.auditDetail}
              </p>
            </ScrollArea>
          </div>
        )}

        {result.ruleResults && result.ruleResults.length > 0 && (
          <RuleResultSection ruleResults={result.ruleResults} />
        )}
      </CardContent>
    </Card>
  );
}

function RuleResultSection({ ruleResults }: { ruleResults: RuleAuditResult[] }) {
  const [expandedRules, setExpandedRules] = useState<Set<string>>(new Set());

  const getRuleKey = (ruleResult: RuleAuditResult) =>
    `${ruleResult.ruleId}:${ruleResult.stage || 'audit'}:${ruleResult.ruleName}`;

  const toggleRule = (ruleKey: string) => {
    setExpandedRules((prev) => {
      const next = new Set(prev);
      if (next.has(ruleKey)) next.delete(ruleKey);
      else next.add(ruleKey);
      return next;
    });
  };

  return (
    <div>
      <h3 className="mb-2 text-xs font-medium text-slate-400">各规则审核详情</h3>
      <div className="space-y-1.5">
        {ruleResults.map((ruleResult) => {
          const ruleKey = getRuleKey(ruleResult);
          const isExpanded = expandedRules.has(ruleKey);
          const conclusionStyle =
            ruleResult.conclusion === '合规'
              ? 'text-[#10b981]'
              : ruleResult.conclusion === '违规'
                ? 'text-[#ef4444]'
                : 'text-[#eab308]';

          return (
            <div key={ruleKey} className="rounded-md border border-[#2a2d3a] bg-[#14161e]">
              <button
                onClick={() => toggleRule(ruleKey)}
                className="flex w-full items-center gap-2 p-2.5 text-left"
              >
                {ruleResult.conclusion === '合规' ? (
                  <CheckCircle className="h-3.5 w-3.5 flex-shrink-0 text-[#10b981]" />
                ) : ruleResult.conclusion === '违规' ? (
                  <XCircle className="h-3.5 w-3.5 flex-shrink-0 text-[#ef4444]" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 text-[#eab308]" />
                )}
                <span className="flex-1 text-xs text-[#e2e8f0]">
                  {ruleResult.ruleName}
                  {ruleResult.stage === 'intent' ? ' · 意图识别' : ''}
                </span>
                <span className={`text-[10px] font-medium ${conclusionStyle}`}>{ruleResult.conclusion}</span>
                <span className="flex items-center gap-0.5 rounded bg-[#1e2030] px-1 py-0.5 text-[10px] text-[#64748b]">
                  <Cpu className="h-2.5 w-2.5" />
                  {ruleResult.model}
                </span>
                {isExpanded ? (
                  <ChevronUp className="h-3 w-3 text-[#64748b]" />
                ) : (
                  <ChevronDown className="h-3 w-3 text-[#64748b]" />
                )}
              </button>
              {isExpanded && (
                <div className="space-y-2 px-2.5 pb-2.5">
                  {ruleResult.violations.length > 0 && (
                    <div className="space-y-1.5">
                      {ruleResult.violations.map((violation, index) => (
                        <ViolationCard key={index} violation={violation} />
                      ))}
                    </div>
                  )}
                  <div className="rounded bg-[#0f1117] p-2">
                    <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-[#94a3b8]">
                      {ruleResult.analysis}
                    </p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
