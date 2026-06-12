'use client';

import React from 'react';
import { Globe, CheckCircle, XCircle, Clock, Loader2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { AuditResult, AuditStatus } from '@/lib/types';

interface LinkListProps {
  results: AuditResult[];
  selectedIndex: number | null;
  onSelect: (index: number) => void;
}

const statusConfig: Record<
  AuditStatus,
  { icon: React.ElementType; color: string; label: string; bg: string }
> = {
  pending: { icon: Clock, color: 'text-slate-400', label: '待审核', bg: 'bg-slate-500/10' },
  scraping: { icon: Loader2, color: 'text-blue-400', label: '抓取中', bg: 'bg-blue-500/10' },
  fetched: { icon: Clock, color: 'text-cyan-400', label: '已抓取', bg: 'bg-cyan-500/10' },
  auditing: { icon: Loader2, color: 'text-purple-400', label: '审核中', bg: 'bg-purple-500/10' },
  passed: { icon: CheckCircle, color: 'text-emerald-400', label: '合规', bg: 'bg-emerald-500/10' },
  violated: { icon: XCircle, color: 'text-red-400', label: '违规', bg: 'bg-red-500/10' },
  review: { icon: AlertTriangle, color: 'text-amber-400', label: '待复核', bg: 'bg-amber-500/10' },
  unaudited: { icon: Clock, color: 'text-slate-500', label: '未审核', bg: 'bg-slate-500/10' },
  error: { icon: AlertTriangle, color: 'text-yellow-400', label: '错误', bg: 'bg-yellow-500/10' },
};

export function LinkList({ results, selectedIndex, onSelect }: LinkListProps) {
  if (results.length === 0) {
    return (
      <Card className="border-border/50 bg-[#1a1d27]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <Globe className="h-4 w-4 text-blue-400" />
            链接列表
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-[200px] items-center justify-center text-sm text-slate-500">
            导入链接后，待审核内容会显示在这里
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-border/50 bg-[#1a1d27]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium text-slate-300">
          <span className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-blue-400" />
            链接列表
          </span>
          <span className="text-xs text-slate-500">{results.length} 条</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[400px]">
          <div className="space-y-1 px-4 pb-4">
            {results.map((result, index) => {
              const status = statusConfig[result.status];
              const StatusIcon = status.icon;
              const isSelected = selectedIndex === index;

              return (
                <button
                  key={result.id}
                  onClick={() => onSelect(index)}
                  className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    isSelected ? 'bg-slate-700/50 ring-1 ring-slate-600' : 'hover:bg-slate-800/50'
                  }`}
                >
                  <div className={`mt-0.5 shrink-0 rounded-md p-1 ${status.bg}`}>
                    <StatusIcon
                      className={`h-3.5 w-3.5 ${status.color} ${
                        result.status === 'scraping' || result.status === 'auditing'
                          ? 'animate-spin'
                          : ''
                      }`}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs text-slate-300">
                      {result.productLink.name || result.productLink.url}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-slate-500">
                      {result.productLink.url}
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className={`shrink-0 border-0 text-[10px] ${status.color} ${status.bg}`}
                  >
                    {status.label}
                  </Badge>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
