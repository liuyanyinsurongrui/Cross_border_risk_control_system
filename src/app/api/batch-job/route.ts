import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import {
  createInitialBatchJobState,
  getBatchJobConfigPath,
  writeBatchJobConfig,
  writeBatchJobState,
} from '@/lib/batch-job';
import { readFeishuConfig } from '@/lib/feishu-config-store';
import { resolveFeishuConfig } from '@/lib/feishu-service';
import type { AuditRules, BatchJobConfig, FeishuConfig, ModelApiConfig } from '@/lib/types';

async function saveUploadedFile(file: File, jobId: string) {
  const jobsDir = path.dirname(getBatchJobConfigPath(jobId));
  await fs.mkdir(jobsDir, { recursive: true });
  const filePath = path.join(jobsDir, file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(filePath, buffer);
  return filePath;
}

function startWorker(jobId: string) {
  const tsxCliPath =
    process.platform === 'win32'
      ? path.join(process.cwd(), 'node_modules', '.bin', 'tsx.CMD')
      : path.join(process.cwd(), 'node_modules', '.bin', 'tsx');
  const workerEntry = path.join(process.cwd(), 'src', 'batch-worker.ts');
  const command = process.platform === 'win32' ? 'cmd.exe' : tsxCliPath;
  const args = process.platform === 'win32' ? ['/c', tsxCliPath, workerEntry, jobId] : [workerEntry, jobId];

  const child = spawn(command, args, {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });

  child.unref();
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const sourceType = String(formData.get('sourceType') || 'upload') as 'upload' | 'local-path';
    const file = formData.get('file') as File | null;
    const localFilePath = String(formData.get('localFilePath') || '').trim();
    const modelConfig = JSON.parse(String(formData.get('modelConfig') || '{}')) as ModelApiConfig;
    const requestFeishuConfig = JSON.parse(String(formData.get('feishuConfig') || '{}')) as FeishuConfig;
    const rules = JSON.parse(String(formData.get('rules') || '{}')) as AuditRules;

    if (!modelConfig?.apiKey) {
      return NextResponse.json({ error: '请先完成模型配置' }, { status: 400 });
    }

    if (
      !requestFeishuConfig?.appId ||
      !requestFeishuConfig?.appSecret ||
      !requestFeishuConfig?.appToken ||
      !requestFeishuConfig?.tableId
    ) {
      return NextResponse.json({ error: '请先完成飞书配置，并填写已有的 App Token 和 Table ID' }, { status: 400 });
    }

    const storedFeishuConfig = await readFeishuConfig();
    const mergedFeishuConfig: FeishuConfig =
      storedFeishuConfig?.appId === requestFeishuConfig.appId
        ? {
            ...requestFeishuConfig,
            ...storedFeishuConfig,
            appId: requestFeishuConfig.appId,
            appSecret: requestFeishuConfig.appSecret,
          }
        : requestFeishuConfig;

    const normalizedFeishuConfig =
      mergedFeishuConfig.authMode === 'user'
        ? (await resolveFeishuConfig(mergedFeishuConfig)).config
        : mergedFeishuConfig;

    const jobId = randomUUID();
    let filePath = '';
    let fileName = '';

    if (sourceType === 'upload') {
      if (!file) {
        return NextResponse.json({ error: '缺少上传文件' }, { status: 400 });
      }
      fileName = file.name;
      filePath = await saveUploadedFile(file, jobId);
    } else {
      if (!localFilePath) {
        return NextResponse.json({ error: '请输入本地文件路径' }, { status: 400 });
      }
      await fs.access(localFilePath);
      filePath = localFilePath;
      fileName = path.basename(localFilePath);
    }

    const config: BatchJobConfig = {
      jobId,
      sourceType,
      filePath,
      fileName,
      createdAt: Date.now(),
      serverBaseUrl: `${request.nextUrl.protocol}//${request.nextUrl.host}`,
      modelConfig,
      feishuConfig: normalizedFeishuConfig,
      rules,
    };

    await writeBatchJobConfig(config);
    await writeBatchJobState(createInitialBatchJobState(config));
    startWorker(jobId);

    return NextResponse.json({
      success: true,
      jobId,
      fileName,
      sourceType,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '创建后台任务失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
