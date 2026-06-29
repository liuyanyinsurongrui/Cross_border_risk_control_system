import { runBatchJob } from '@/lib/batch-runner';

async function main() {
  const jobId = process.argv[2];

  if (!jobId) {
    console.error('Missing batch job id');
    process.exit(1);
  }

  try {
    await runBatchJob(jobId);
    process.exit(0);
  } catch (error) {
    console.error('[batch-worker] failed', error);
    process.exit(1);
  }
}

void main();
