import { NextRequest, NextResponse } from 'next/server';
import { readBatchJobState } from '@/lib/batch-job';

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await context.params;
    const state = await readBatchJobState(jobId);
    return NextResponse.json({ success: true, state });
  } catch (error) {
    const message = error instanceof Error ? error.message : '读取任务状态失败';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
