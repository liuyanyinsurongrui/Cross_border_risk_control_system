'use client';

import React, { useEffect, useState } from 'react';
import { Bot, FolderOpen, Loader2, Play, TerminalSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AuditRules, BatchJobState, FeishuConfig, ModelApiConfig } from '@/lib/types';

interface BatchModePanelProps {
  modelConfig: ModelApiConfig | null;
  feishuConfig: FeishuConfig | null;
  rules: AuditRules;
}

export function BatchModePanel({ modelConfig, feishuConfig, rules }: BatchModePanelProps) {
  const [localFilePath, setLocalFilePath] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [jobState, setJobState] = useState<BatchJobState | null>(null);
  const [jobId, setJobId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!jobId) return;

    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/batch-job/${jobId}`);
        const data = (await response.json()) as { state?: BatchJobState };
        if (data.state) {
          setJobState(data.state);
          if (data.state.phase === 'completed' || data.state.phase === 'failed') {
            window.clearInterval(timer);
          }
        }
      } catch {
        // ignore polling error
      }
    }, 2000);

    return () => window.clearInterval(timer);
  }, [jobId]);

  const handleSubmit = async (sourceType: 'upload' | 'local-path') => {
    if (!modelConfig?.apiKey) {
      alert('请先完成模型配置');
      return;
    }

    if (!feishuConfig?.appId || !feishuConfig?.appSecret) {
      alert('请先完成飞书配置');
      return;
    }

    if (sourceType === 'upload' && !file) {
      alert('请先上传本地 Excel 文件');
      return;
    }

    if (sourceType === 'local-path' && !localFilePath.trim()) {
      alert('请输入本地 Excel 文件路径');
      return;
    }

    setIsSubmitting(true);
    try {
      const formData = new FormData();
      formData.append('sourceType', sourceType);
      if (file) formData.append('file', file);
      if (localFilePath.trim()) formData.append('localFilePath', localFilePath.trim());
      formData.append('modelConfig', JSON.stringify(modelConfig));
      formData.append('feishuConfig', JSON.stringify(feishuConfig));
      formData.append('rules', JSON.stringify(rules));

      const response = await fetch('/api/batch-job', {
        method: 'POST',
        body: formData,
      });
      const data = (await response.json()) as { error?: string; jobId?: string };
      if (!response.ok || data.error || !data.jobId) {
        throw new Error(data.error || '创建后台任务失败');
      }

      setJobId(data.jobId);
      setJobState(null);
    } catch (error) {
      alert(error instanceof Error ? error.message : '创建后台任务失败');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card className="border-border/50 bg-[#1a1d27]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <TerminalSquare className="h-4 w-4 text-cyan-400" />
          CMD 后台批量审核
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3 text-xs text-cyan-200">
          <p>适用于大批量 Excel 文件后台审核。</p>
          <p className="mt-1">流程：去重与无效商品名过滤 → 按规则做商品名筛选 → 图片/文字抓取 → AI 审核 → 写入已配置的飞书多维表格</p>
        </div>

        <div className="space-y-2">
          <Label className="text-xs text-slate-400">方式一：输入本地文件路径</Label>
          <div className="flex gap-2">
            <Input
              value={localFilePath}
              onChange={(event) => setLocalFilePath(event.target.value)}
              placeholder="例如：C:\\Users\\dell\\Desktop\\products.xlsx"
              className="border-slate-600 bg-slate-900 text-sm text-slate-200 placeholder:text-slate-600"
            />
            <Button
              onClick={() => void handleSubmit('local-path')}
              disabled={isSubmitting}
              className="gap-2 bg-cyan-600 text-white hover:bg-cyan-700"
            >
              {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
              后台运行
            </Button>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="text-xs text-slate-400">方式二：上传本地 Excel 文件</Label>
          <div className="flex gap-2">
            <Input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
              className="border-slate-600 bg-slate-900 text-sm text-slate-200 file:text-slate-300"
            />
            <Button
              onClick={() => void handleSubmit('upload')}
              disabled={isSubmitting}
              className="gap-2 bg-cyan-600 text-white hover:bg-cyan-700"
            >
              {isSubmitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              后台运行
            </Button>
          </div>
        </div>

        {jobState && (
          <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
            <div className="mb-2 flex items-center gap-2">
              <Bot className="h-3.5 w-3.5 text-cyan-400" />
              <span>任务状态：{jobState.phase}</span>
            </div>
            <p>{jobState.phase === 'failed' && jobState.error ? jobState.error : jobState.message}</p>
            <p className="mt-2 text-slate-400">
              总行数 {jobState.progress.totalRows} / 去重后 {jobState.progress.deduplicatedRows} / 可审核 {jobState.progress.eligibleRows}
            </p>
            <p className="text-slate-400">
              已处理 {jobState.progress.processedRows} / 成功 {jobState.progress.successRows} / 失败 {jobState.progress.failedRows} / 跳过 {jobState.progress.skippedRows}
            </p>
            {jobState.error && <p className="mt-2 text-red-400">{jobState.error}</p>}
            {jobState.bitableUrl && (
              <a href={jobState.bitableUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-cyan-400 hover:text-cyan-300">
                打开飞书多维表格
              </a>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
