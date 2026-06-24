import { NextRequest, NextResponse } from 'next/server';
import { formatAuditErrorMessage, runAudit } from '@/lib/audit-service';
import type { AuditRules, ModelApiConfig, ScrapedContent } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      content: ScrapedContent;
      rules?: AuditRules;
      modelConfig?: ModelApiConfig | null;
    };

    const { content, rules, modelConfig } = body;

    if (!content) {
      return NextResponse.json({ error: '缺少审核内容' }, { status: 400 });
    }

    const { result, ruleResults, screeningLabel, adultConclusion, matchedRuleNames } = await runAudit(
      content,
      rules,
      modelConfig
    );

    return NextResponse.json({
      success: true,
      result,
      ruleResults,
      screeningLabel,
      adultConclusion,
      matchedRuleNames,
    });
  } catch (error) {
    return NextResponse.json({ error: formatAuditErrorMessage(error) }, { status: 500 });
  }
}
