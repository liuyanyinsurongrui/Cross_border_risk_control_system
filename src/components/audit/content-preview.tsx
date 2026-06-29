'use client';

import React, { useState } from 'react';
import { FileText, Image as ImageIcon, ExternalLink, X, ZoomIn, Package, FileSearch } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ScrapedContent, ScrapedImage } from '@/lib/types';

interface ContentPreviewProps {
  content: ScrapedContent | undefined;
  isLoading: boolean;
}

function ImageLightbox({ img, onClose }: { img: ScrapedImage; onClose: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const src = img.url || img.originalUrl;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute right-4 top-4 rounded-full bg-slate-800 p-2 text-white hover:bg-slate-700"
      >
        <X className="h-5 w-5" />
      </button>
      <div onClick={(event) => event.stopPropagation()} className="relative max-h-[90vh] max-w-[90vw]">
        {!loaded && !error && (
          <div className="flex h-48 w-96 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
          </div>
        )}
        {error ? (
          <div className="flex h-48 w-96 flex-col items-center justify-center gap-2 rounded-lg bg-slate-800 p-4">
            <ImageIcon className="h-8 w-8 text-slate-500" />
            <p className="text-sm text-slate-400">图片加载失败</p>
            <a
              href={src}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-400 hover:underline"
            >
              在新标签页打开
            </a>
          </div>
        ) : (
          <img
            src={src}
            alt="放大预览"
            className={`max-h-[90vh] max-w-[90vw] rounded-lg object-contain ${loaded ? 'block' : 'hidden'}`}
            onLoad={() => setLoaded(true)}
            onError={() => {
              setError(true);
              setLoaded(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

function ImageGrid({
  images,
  onImageClick,
  emptyText,
}: {
  images: ScrapedImage[];
  onImageClick: (img: ScrapedImage) => void;
  emptyText: string;
}) {
  if (images.length === 0) {
    return <p className="text-xs text-slate-500">{emptyText}</p>;
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      {images.map((img, index) => (
        <div
          key={index}
          className="group relative cursor-pointer overflow-hidden rounded-md border border-slate-700 bg-slate-900"
          onClick={() => onImageClick(img)}
        >
          <img
            src={img.thumbnailUrl || img.url || img.originalUrl}
            alt={`图片 ${index + 1}`}
            className="h-20 w-full object-cover transition-transform duration-200 group-hover:scale-110"
            loading="lazy"
            onError={(event) => {
              const target = event.currentTarget;
              const triedSrc = target.src;
              if (triedSrc === img.thumbnailUrl && img.url) {
                target.src = img.url;
              } else if (triedSrc === img.url && img.originalUrl && img.originalUrl !== img.url) {
                target.src = img.originalUrl;
              } else {
                target.style.display = 'none';
                const fallback = document.createElement('div');
                fallback.className = 'flex h-20 items-center justify-center text-xs text-slate-500';
                fallback.textContent = '加载失败';
                target.parentElement?.appendChild(fallback);
              }
            }}
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-opacity group-hover:bg-black/40 group-hover:opacity-100">
            <ZoomIn className="h-5 w-5 text-white" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ContentPreview({ content, isLoading }: ContentPreviewProps) {
  const [lightboxImg, setLightboxImg] = useState<ScrapedImage | null>(null);

  if (isLoading) {
    return (
      <Card className="border-border/50 bg-[#1a1d27]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <FileText className="h-4 w-4 text-purple-400" />
            内容预览
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-[200px] items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
              <p className="text-sm text-slate-500">正在抓取页面内容...</p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!content) {
    return (
      <Card className="border-border/50 bg-[#1a1d27]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-slate-300">
            <FileText className="h-4 w-4 text-purple-400" />
            内容预览
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex min-h-[200px] items-center justify-center text-sm text-slate-500">
            选中链接并开始审核后，抓取内容会显示在这里
          </div>
        </CardContent>
      </Card>
    );
  }

  const productImages = content.productImages ?? content.images ?? [];
  const detailImages = content.detailImages ?? [];

  return (
    <>
      <Card className="border-border/50 bg-[#1a1d27]">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-sm font-medium text-slate-300">
            <span className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-purple-400" />
              内容预览
            </span>
            <a
              href={content.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
            >
              <ExternalLink className="h-3 w-3" />
              原始页面
            </a>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {content.title && (
            <div>
              <h3 className="mb-1 text-xs font-medium text-slate-400">页面标题</h3>
              <p className="text-sm text-slate-200">{content.title}</p>
            </div>
          )}

          <div>
            <h3 className="mb-1 flex items-center gap-1 text-xs font-medium text-slate-400">
              <FileText className="h-3 w-3" />
              文字内容
            </h3>
            <ScrollArea className="h-[120px] rounded-md bg-slate-900/50 p-3">
              <p className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-300">
                {content.textContent || '未提取到文字内容'}
              </p>
            </ScrollArea>
          </div>

          <div>
            <h3 className="mb-2 flex items-center gap-1 text-xs font-medium text-slate-400">
              <Package className="h-3 w-3" />
              产品素材图（{productImages.length}）
            </h3>
            <ImageGrid
              images={productImages}
              onImageClick={setLightboxImg}
              emptyText="未提取到产品素材图"
            />
          </div>

          <div>
            <h3 className="mb-2 flex items-center gap-1 text-xs font-medium text-slate-400">
              <FileSearch className="h-3 w-3" />
              产品详情图（{detailImages.length}）
            </h3>
            <ImageGrid
              images={detailImages}
              onImageClick={setLightboxImg}
              emptyText="未提取到产品详情图"
            />
          </div>
        </CardContent>
      </Card>

      {lightboxImg && <ImageLightbox img={lightboxImg} onClose={() => setLightboxImg(null)} />}
    </>
  );
}
