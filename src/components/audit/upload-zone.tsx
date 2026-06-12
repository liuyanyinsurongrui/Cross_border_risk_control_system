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

export function UploadZone({ onLinksAdded, isLoading, setIsLoading }: UploadZoneProps) {
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [linkInput, setLinkInput] = useState('');
  const [batchInputOpen, setBatchInputOpen] = useState(false);
  const [batchInput, setBatchInput] = useState('');

  const parseBatchLinks = useCallback((value: string): ProductLink[] => {
    const lines = value
      .split(/[\n\r,，\t]+/)
      .map((item) => item.trim())
      .filter(Boolean);

    const seen = new Set<string>();
    const now = Date.now();

    return lines.flatMap((url, index) => {
      const normalizedUrl = normalizeUrlInput(url);
      if (!normalizedUrl || seen.has(normalizedUrl)) {
        return [];
      }

      seen.add(normalizedUrl);
      return [
        {
          id: `link_batch_${now}_${index}`,
          url: normalizedUrl,
          status: 'pending',
        },
      ];
    });
  }, []);

  const batchPreviewCount = useMemo(
    () => parseBatchLinks(batchInput).length,
    [batchInput, parseBatchLinks]
  );

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
    const rawUrl = linkInput.trim();
    if (!rawUrl) {
      setError('请输入产品链接');
      return;
    }

    const normalizedUrl = normalizeUrlInput(rawUrl);
    if (!normalizedUrl) {
      setError('请输入有效的商品链接，系统会自动补全未填写的协议头。');
      return;
    }

    onLinksAdded([
      {
        id: `link_manual_${Date.now()}`,
        url: normalizedUrl,
        status: 'pending',
      },
    ]);

    setLinkInput('');
    setError(null);
  }, [linkInput, onLinksAdded]);

  const handleBatchSubmit = useCallback(() => {
    const links = parseBatchLinks(batchInput);
    if (links.length === 0) {
      setError('未识别到有效链接，请按每行一个 URL 输入。');
      return;
    }

    onLinksAdded(links);
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
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-slate-400">单条链接提交</p>
              <button
                type="button"
                onDoubleClick={() => {
                  setBatchInputOpen(true);
                  setError(null);
                }}
                className="text-[10px] text-slate-500 transition hover:text-slate-300"
              >
                双击这里批量输入
              </button>
            </div>
            <div
              className="flex gap-2"
              onDoubleClick={() => {
                setBatchInputOpen(true);
                setError(null);
              }}
            >
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
              className={`relative flex min-h-[80px] cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed transition-colors ${
                dragActive
                  ? 'border-emerald-500 bg-emerald-500/10'
                  : 'border-slate-600 bg-slate-800/30 hover:border-slate-500 hover:bg-slate-800/50'
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
                className={`mb-2 h-6 w-6 ${dragActive ? 'text-emerald-400' : 'text-slate-500'}`}
              />
              <p className="text-xs text-slate-400">
                {isLoading ? '解析中...' : '拖拽 Excel 文件到此或点击上传'}
              </p>
              <p className="mt-1 text-[10px] text-slate-500">支持 .xlsx / .xls / .csv</p>
              {fileName && !error && <p className="mt-2 text-[10px] text-emerald-400/80">{fileName}</p>}
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
        <DialogContent className="border-slate-700 bg-[#1a1d27] sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-slate-200">
              <Files className="h-4 w-4 text-emerald-400" />
              批量输入链接
            </DialogTitle>
            <DialogDescription className="text-slate-400">
              每行一个链接，也支持逗号分隔。双击单条输入区域即可快速打开这里。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <Textarea
              value={batchInput}
              onChange={(event) => {
                setBatchInput(event.target.value);
                setError(null);
              }}
              placeholder={'https://example.com/products/1\nexample.com/products/2\nwww.example.com/products/3'}
              className="min-h-[220px] resize-none border-slate-600 bg-slate-900 text-sm text-slate-200 placeholder:text-slate-600"
            />
            <div className="text-xs text-slate-500">
              当前识别到 {batchPreviewCount} 条有效链接（支持自动补全 `https://`）
            </div>
            <div className="flex justify-end gap-2">
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
                disabled={!batchInput.trim()}
                className="bg-emerald-600 text-white hover:bg-emerald-700"
              >
                导入链接
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
