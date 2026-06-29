import { NextRequest, NextResponse } from 'next/server';
import { writeFeishuConfig } from '@/lib/feishu-config-store';
import { pushAuditResultsToFeishu } from '@/lib/feishu-service';
import type { AuditResult, FeishuConfig } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      config: FeishuConfig;
      results: AuditResult[];
    };

    const { config, results } = body;
    const pushResult = await pushAuditResultsToFeishu(config, results);
    if (pushResult.updatedConfig) {
      await writeFeishuConfig(pushResult.updatedConfig);
    }

    return NextResponse.json({
      success: true,
      total: pushResult.total,
      successCount: pushResult.successCount,
      failCount: pushResult.failCount,
      details: pushResult.details,
      createdFields: pushResult.createdFields,
      bitableUrl: pushResult.bitableUrl,
      updatedConfig: pushResult.updatedConfig,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '推送失败';
    return NextResponse.json({ error: `飞书推送失败：${message}` }, { status: 500 });
  }
}
