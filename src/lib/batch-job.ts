import { promises as fs } from 'fs';
import path from 'path';
import type { BatchJobConfig, BatchJobProgress, BatchJobState } from '@/lib/types';

const JOB_ROOT_DIR = path.join(process.cwd(), '.batch-jobs');

const EMPTY_PROGRESS: BatchJobProgress = {
  totalRows: 0,
  deduplicatedRows: 0,
  eligibleRows: 0,
  processedRows: 0,
  skippedRows: 0,
  successRows: 0,
  failedRows: 0,
};

export function getBatchJobRootDir() {
  return JOB_ROOT_DIR;
}

export function getBatchJobDir(jobId: string) {
  return path.join(JOB_ROOT_DIR, jobId);
}

export function getBatchJobConfigPath(jobId: string) {
  return path.join(getBatchJobDir(jobId), 'config.json');
}

export function getBatchJobStatePath(jobId: string) {
  return path.join(getBatchJobDir(jobId), 'state.json');
}

export async function ensureBatchJobDir(jobId: string) {
  await fs.mkdir(getBatchJobDir(jobId), { recursive: true });
}

export async function writeBatchJobConfig(config: BatchJobConfig) {
  await ensureBatchJobDir(config.jobId);
  await fs.writeFile(
    getBatchJobConfigPath(config.jobId),
    JSON.stringify(config, null, 2),
    'utf8'
  );
}

export async function readBatchJobConfig(jobId: string) {
  const content = await fs.readFile(getBatchJobConfigPath(jobId), 'utf8');
  return JSON.parse(content) as BatchJobConfig;
}

export function createInitialBatchJobState(config: BatchJobConfig): BatchJobState {
  return {
    jobId: config.jobId,
    phase: 'queued',
    step: 'waiting',
    message: '后台 CMD 批量审核任务已创建，等待启动。',
    progress: { ...EMPTY_PROGRESS },
    sourceType: config.sourceType,
    sourceFilePath: config.filePath,
    sourceFileName: config.fileName,
  };
}

export async function writeBatchJobState(state: BatchJobState) {
  await ensureBatchJobDir(state.jobId);
  await fs.writeFile(
    getBatchJobStatePath(state.jobId),
    JSON.stringify(state, null, 2),
    'utf8'
  );
}

export async function readBatchJobState(jobId: string) {
  const content = await fs.readFile(getBatchJobStatePath(jobId), 'utf8');
  return JSON.parse(content) as BatchJobState;
}
