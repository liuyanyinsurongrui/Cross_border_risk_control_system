'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { AlertCircle, FileSpreadsheet, Files, Link as LinkIcon, Plus, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { ProductLink } from '@/lib/types';

interface UploadZoneProps {
  onLinksAdded: (links: ProductLink[]) => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  existingUrls?: string[];
}

interface ParsedBatchInput {
  links: ProductLink[];
  invalidCount: number;
  duplicateCount: number;
  existingDuplicateCount: number;
}

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

function buildProductLink(url: string, id: string): ProductLink {
  return {
    id,
    url,
    status: 'pending',
  };
}

export function UploadZone({
  onLinksAdded,
  isLoading,
  setIsLoading,
  existingUrls = [],
}: UploadZoneProps) {
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [batchInputOpen, setBatchInputOpen] = useState(false);
  const [batchInput, setBatchInput] = useState('');

  const existingUrlSet = useMemo(() => new Set(existingUrls), [existingUrls]);

  const parseBatchLinks = useCallback(
    (value: string): ParsedBatchInput => {
      const segments = value
        .split(/[\s,，]+/)
        .map((item) => item.trim())
        .filter(Boolean);

      const links: ProductLink[] = [];
      const seen = new Set<string>();
      const now = Date.now();
      let invalidCount = 0;
      let duplicateCount = 0;
      let existingDuplicateCount = 0;

      segments.forEach((segment, index) => {
        const normalizedUrl = normalizeUrlInput(segment);

        if (!normalizedUrl) {
          invalidCount += 1;
          return;
        }

        if (existingUrlSet.has(normalizedUrl)) {
          existingDuplicateCount += 1;
          return;
        }

        if (seen.has(normalizedUrl)) {
          duplicateCount += 1;
          return;
        }

        seen.add(normalizedUrl);
        links.push(buildProductLink(normalizedUrl, `link_batch_${now}_${index}`));
      });

      return {
        links,
        invalidCount,
        duplicateCount,
        existingDuplicateCount,
      };
    },
    [existingUrlSet]
  );

  const batchPreview = useMemo(() => parseBatchLinks(batchInput), [batchInput, parseBatchLinks]);

  const handleFile = useCallback(
    async (file: File) => {
      setError(null);
      setFileName(file.name);

      const validTypes = [
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-excel',
        'text/csv',
      ];
      const ext = file.name.split('.').pop()?.toLowerCase();

      if (!validTypes.includes(file.type) && !['xlsx', 'xls', 'csv'].includes(ext || '')) {
        setError('请上传 Excel 文件（.xlsx / .xls）或 CSV 文件');
        return;
      }

      setIsLoading(true);
      try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        const data = await response.json();
        if (!response.ok || data.error) {
          setError(data.error || '文件解析失败');
          return;
        }

        onLinksAdded(data.links);
      } catch {
        setError('文件上传失败，请重试');
      } finally {
        setIsLoading(false);
      }
    },
    [onLinksAdded, setIsLoading]
  );

  const handleLinkSubmit = useCallback(() => {
    const rawValue = linkInput.trim();
    if (!rawValue) {
      setError('请输入商品链接');
      return;
    }

    const parsedBatch = parseBatchLinks(rawValue);
    if (parsedBatch.links.length > 1) {
      onLinksAdded(parsedBatch.links);
      setLinkInput('');
      setError(null);
      return;
    }

    const normalizedUrl = normalizeUrlInput(rawValue);
    if (!normalizedUrl) {
      setError('请输入有效的商品链接，系统会自动补全 https://');
      return;
    }

    if (existingUrlSet.has(normalizedUrl)) {
      setError('这个链接已经在当前审核列表里了');
      return;
    }

    onLinksAdded([buildProductLink(normalizedUrl, `link_manual_${Date.now()}`)]);
    setLinkInput('');
    setError(null);
  }, [existingUrlSet, linkInput, onLinksAdded, parseBatchLinks]);

  const handleBatchSubmit = useCallback(() => {
    const parsed = parseBatchLinks(batchInput);
    if (parsed.links.length === 0) {
      if (parsed.existingDuplicateCount > 0 && parsed.invalidCount === 0) {
        setError('这批链接都已经在当前审核列表里了');
        return;
      }

      setError('没有识别到可导入的有效链接，请按每行一个链接或空格分隔后重试');
      return;
    }

    onLinksAdded(parsed.links);
    setBatchInput('');
    setBatchInputOpen(false);
    setError(null);
  }, [batchInput, onLinksAdded, parseBatchLinks]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        handleLinkSubmit();
      }
    },
    [handleLinkSubmit]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      const file = event.dataTransfer.files[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragActive(false);
  }, []);

  const handleInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  const openBatchDialog = useCallback(() => {
    setBatchInputOpen(true);
    setError(null);
  }, []);

  return (
    <>
      <Card className="border-border/50 bg-[#1a1d27]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <FileSpreadsheet className="h-4 w-4 text-emerald-400" />
            数据导入
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-slate-400">单条链接提交</p>
              <button
                type="button"
                onDoubleClick={openBatchDialog}
                className="text-[10px] text-slate-500 transition hover:text-slate-300"
              >
                双击这里批量输入
              </button>
            </div>
            <div className="flex gap-2" onDoubleClick={openBatchDialog}>
              <div className="relative flex-1">
                <LinkIcon className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <Input
                  value={linkInput}
                  onChange={(event) => {
                    setLinkInput(event.target.value);
                    setError(null);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="输入产品链接 URL"
                  className="border-slate-600 bg-slate-900 pl-9 text-xs text-slate-300 placeholder:text-slate-600"
                  disabled={isLoading}
                />
              </div>
              <Button
                onClick={handleLinkSubmit}
                disabled={isLoading || !linkInput.trim()}
                size="sm"
                className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                添加
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="h-px flex-1 bg-slate-700/50" />
            <span className="text-[10px] text-slate-600">或</span>
            <div className="h-px flex-1 bg-slate-700/50" />
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-slate-400">批量导入</p>
            <div
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              className={`relative flex min-h-[88px] cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed transition-colors ${
                dragActive
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-slate-600 bg-slate-800/20 hover:border-slate-500 hover:bg-slate-800/40'
              }`}
            >
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleInputChange}
                className="absolute inset-0 cursor-pointer opacity-0"
                disabled={isLoading}
              />
              <Upload
                className={`mb-2 h-5 w-5 ${dragActive ? 'text-emerald-400' : 'text-slate-500'}`}
              />
              <p className="text-xs text-slate-400">
                {isLoading ? '正在解析文件...' : '拖拽 Excel 文件到这里或点击上传'}
              </p>
              <p className="mt-1 text-[10px] text-slate-500">支持 .xlsx / .xls / .csv</p>
              {fileName && !error && (
                <p className="mt-2 text-[10px] text-emerald-400/80">{fileName}</p>
              )}
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-400">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={batchInputOpen} onOpenChange={setBatchInputOpen}>
        <DialogContent className="flex h-[min(78vh,760px)] w-[min(760px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden border-slate-700 bg-[#1a1d27] p-0">
          <DialogHeader className="shrink-0 border-b border-slate-700 px-6 pt-6 pb-3">
            <DialogTitle className="flex items-center gap-2 text-slate-200">
              <Files className="h-4 w-4 text-emerald-400" />
              批量输入链接
            </DialogTitle>
            <DialogDescription className="text-slate-400">
              每行一个链接，也支持逗号分隔。输入过多时可直接在输入框内上下滚动。
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
            <Textarea
              value={batchInput}
              onChange={(event) => {
                setBatchInput(event.target.value);
                setError(null);
              }}
              placeholder={'https://example.com/products/1\nhttps://example.com/products/2\nexample.com/products/3'}
              wrap="soft"
              spellCheck={false}
              className="h-full min-h-0 flex-1 resize-none overflow-y-auto border-slate-600 bg-[#0f1117] font-mono text-xs leading-5 text-slate-200 placeholder:text-slate-600"
            />

            <div className="mt-3 shrink-0 space-y-3">
              <div className="flex flex-wrap gap-2 text-[11px]">
                <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-300">
                  可导入 {batchPreview.links.length}
                </span>
                {batchPreview.duplicateCount > 0 && (
                  <span className="rounded-full bg-slate-500/10 px-2 py-1 text-slate-300">
                    批内重复 {batchPreview.duplicateCount}
                  </span>
                )}
                {batchPreview.existingDuplicateCount > 0 && (
                  <span className="rounded-full bg-amber-500/10 px-2 py-1 text-amber-300">
                    已存在 {batchPreview.existingDuplicateCount}
                  </span>
                )}
                {batchPreview.invalidCount > 0 && (
                  <span className="rounded-full bg-red-500/10 px-2 py-1 text-red-300">
                    无效 {batchPreview.invalidCount}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-500">
                当前识别到 {batchPreview.links.length} 条有效链接。超长内容只会在输入框内部滚动，不会再把弹窗或按钮区撑变形。
              </p>
            </div>
          </div>

          <div className="flex shrink-0 justify-end gap-2 border-t border-slate-700 px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setBatchInputOpen(false)}
              className="text-slate-400"
            >
              取消
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleBatchSubmit}
              disabled={batchPreview.links.length === 0}
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              导入链接
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
