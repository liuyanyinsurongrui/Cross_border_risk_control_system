import { promises as fs } from 'fs';
import path from 'path';
import type { FeishuConfig } from '@/lib/types';

const STORE_DIR = path.join(process.cwd(), '.runtime-store');
const FEISHU_CONFIG_PATH = path.join(STORE_DIR, 'feishu-config.json');

export async function writeFeishuConfig(config: FeishuConfig) {
  await fs.mkdir(STORE_DIR, { recursive: true });
  await fs.writeFile(FEISHU_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
}

export async function readFeishuConfig() {
  try {
    const content = await fs.readFile(FEISHU_CONFIG_PATH, 'utf8');
    return JSON.parse(content) as FeishuConfig;
  } catch {
    return null;
  }
}

