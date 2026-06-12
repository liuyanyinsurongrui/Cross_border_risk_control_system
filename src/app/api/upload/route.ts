import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';

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
      return NextResponse.json({ error: 'Excel文件中没有工作表' }, { status: 400 });
    }

    const worksheet = workbook.Sheets[firstSheetName];
    const jsonData = XLSX.utils.sheet_to_json<Record<string, string>>(worksheet, {
      defval: '',
    });

    if (jsonData.length === 0) {
      return NextResponse.json({ error: 'Excel文件中没有数据' }, { status: 400 });
    }

    // 自动检测URL列名
    const urlColumnKeys = ['url', 'link', '链接', 'URL', '网址', '产品链接', '产品URL', 'product_url', 'product_link'];
    const headers = Object.keys(jsonData[0]);
    const urlKey = headers.find((h) =>
      urlColumnKeys.some((k) => h.toLowerCase().trim() === k.toLowerCase())
    );

    if (!urlKey) {
      // 尝试找到包含http的列
      const httpKey = headers.find((h) =>
        jsonData.some((row) => String(row[h]).includes('http'))
      );
      if (!httpKey) {
        return NextResponse.json(
          { error: '未找到链接列，请确保Excel中包含名为"url"、"链接"或"产品链接"的列' },
          { status: 400 }
        );
      }
    }

    const detectedUrlKey = urlKey || headers.find((h) => jsonData.some((row) => String(row[h]).includes('http')))!;

    // 检测名称列
    const nameKeys = ['name', '名称', '产品名称', 'product_name', 'title', '标题'];
    const nameKey = headers.find((h) =>
      nameKeys.some((k) => h.toLowerCase().trim() === k.toLowerCase())
    );

    // 检测SKU列
    const skuKeys = ['sku', 'SKU', '商品编号', 'product_id', 'id'];
    const skuKey = headers.find((h) =>
      skuKeys.some((k) => h.toLowerCase().trim() === k.toLowerCase())
    );

    // 检测平台列
    const platformKeys = ['platform', '平台', 'site', '站点'];
    const platformKey = headers.find((h) =>
      platformKeys.some((k) => h.toLowerCase().trim() === k.toLowerCase())
    );

    const links = jsonData
      .filter((row) => {
        const val = String(row[detectedUrlKey]).trim();
        return val.startsWith('http://') || val.startsWith('https://');
      })
      .map((row, index) => ({
        id: `link_${index}_${Date.now()}`,
        url: String(row[detectedUrlKey]).trim(),
        name: nameKey ? String(row[nameKey]).trim() : undefined,
        sku: skuKey ? String(row[skuKey]).trim() : undefined,
        platform: platformKey ? String(row[platformKey]).trim() : undefined,
        rawRow: row,
      }));

    if (links.length === 0) {
      return NextResponse.json(
        { error: '未找到有效的产品链接，请确保链接以 http:// 或 https:// 开头' },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: true,
      totalRows: jsonData.length,
      validLinks: links.length,
      detectedColumns: {
        url: detectedUrlKey,
        name: nameKey || null,
        sku: skuKey || null,
        platform: platformKey || null,
      },
      links,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '文件解析失败';
    return NextResponse.json({ error: `Excel解析失败: ${message}` }, { status: 500 });
  }
}
