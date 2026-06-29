import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import {
  ADULT_PREFERRED_EXCEL_COLUMN_ALIASES,
  ADULT_PREFERRED_EXCEL_COLUMNS,
  ADULT_REQUIRED_EXCEL_COLUMN_ALIASES,
  ADULT_REQUIRED_EXCEL_COLUMNS,
} from '@/lib/adult-audit';

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

function detectUrlColumn(rows: Record<string, string>[], headers: string[]) {
  const exactUrlColumnKeys = [
    '落地页链接',
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
      exactUrlColumnKeys.some((key) => normalized === key.toLowerCase())
    )?.original || null;
  if (exactUrlKey) return exactUrlKey;

  const preferredUrlKey =
    normalizedHeaders.find(({ normalized }) =>
      preferredUrlColumnKeys.some(
        (key) => normalized === key.toLowerCase() || normalized.includes(key.toLowerCase())
      )
    )?.original || null;
  if (preferredUrlKey) return preferredUrlKey;

  const fallbackCandidates = normalizedHeaders
    .map(({ original, normalized }) => {
      if (
        discouragedUrlColumnKeys.some(
          (key) => normalized === key.toLowerCase() || normalized.includes(key.toLowerCase())
        )
      ) {
        return { original, validCount: -1 };
      }

      const validCount = rows.reduce((count, row) => {
        return normalizeUrlInput(String(row[original] || '')) ? count + 1 : count;
      }, 0);

      return { original, validCount };
    })
    .filter((item) => item.validCount > 0)
    .sort((left, right) => right.validCount - left.validCount);

  return fallbackCandidates[0]?.original || null;
}

function findHeaderByAliases(headers: string[], aliases: readonly string[]) {
  return (
    headers.find((header) => {
      const normalizedHeader = header.toLowerCase().trim();
      return aliases.some((alias) => normalizedHeader === alias.toLowerCase().trim());
    }) || null
  );
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: '未找到上传文件' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      return NextResponse.json({ error: 'Excel 文件中没有工作表' }, { status: 400 });
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(worksheet, { defval: '' });

    if (jsonData.length === 0) {
      return NextResponse.json({ error: 'Excel 文件中没有数据' }, { status: 400 });
    }

    const headers = Object.keys(jsonData[0]);
    const missingRequiredColumns = ADULT_REQUIRED_EXCEL_COLUMNS.filter((column, index) => {
      if (headers.includes(column)) return false;
      const aliases = ADULT_REQUIRED_EXCEL_COLUMN_ALIASES[index] || [column];
      return !findHeaderByAliases(headers, aliases);
    });

    if (missingRequiredColumns.length > 0) {
      return NextResponse.json(
        {
          error: `Excel 缺少必填列：${missingRequiredColumns.join('、')}。当前模板至少需要：${ADULT_REQUIRED_EXCEL_COLUMNS.join('、')}`,
        },
        { status: 400 }
      );
    }

    const detectedUrlKey = detectUrlColumn(jsonData, headers);
    if (!detectedUrlKey) {
      return NextResponse.json(
        { error: '未找到链接列，请确保 Excel 中包含落地页链接 / 产品链接 / 第三方域名链接 / url 等字段' },
        { status: 400 }
      );
    }

    const nameKey = findHeaderByAliases(headers, ADULT_REQUIRED_EXCEL_COLUMN_ALIASES[0]);
    const skuKey = findHeaderByAliases(headers, ADULT_PREFERRED_EXCEL_COLUMN_ALIASES['虚拟SKU编号']);
    const platformKey = findHeaderByAliases(headers, ADULT_PREFERRED_EXCEL_COLUMN_ALIASES['部门']);

    const links = jsonData
      .map((row, index) => {
        const normalizedUrl = normalizeUrlInput(String(row[detectedUrlKey] || ''));
        if (!normalizedUrl) return null;

        return {
          id: `link_${index}_${Date.now()}`,
          url: normalizedUrl,
          name: nameKey ? String(row[nameKey]).trim() : undefined,
          sku: skuKey ? String(row[skuKey]).trim() : undefined,
          platform: platformKey ? String(row[platformKey]).trim() : undefined,
          rawRow: row,
          screeningLabel: '未筛查',
          status: 'pending',
        };
      })
      .filter(Boolean);

    if (links.length === 0) {
      return NextResponse.json(
        { error: '未找到有效的商品链接，请确认链接列内容正确' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      totalRows: jsonData.length,
      validLinks: links.length,
      detectedColumns: {
        url: detectedUrlKey,
        name: nameKey,
        sku: skuKey,
        platform: platformKey,
        preferred: ADULT_PREFERRED_EXCEL_COLUMNS.filter((column) => headers.includes(column)),
      },
      links,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '文件解析失败';
    return NextResponse.json({ error: `Excel 解析失败: ${message}` }, { status: 500 });
  }
}
