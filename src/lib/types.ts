export type AuditStatus =
  | 'pending'
  | 'scraping'
  | 'fetched'
  | 'auditing'
  | 'passed'
  | 'violated'
  | 'error'
  | 'review'
  | 'unaudited';

export interface ProductLink {
  id: string;
  url: string;
  name?: string;
  sku?: string;
  platform?: string;
  rawRow?: Record<string, unknown>;
  screeningLabel?: string;
  status: AuditStatus;
  scrapedContent?: ScrapedContent;
  auditResult?: AuditResult;
  error?: string;
}

export interface ScrapedContent {
  title: string;
  productName?: string;
  textContent: string;
  productImages: ScrapedImage[];
  detailImages: ScrapedImage[];
  images: ScrapedImage[];
  url: string;
  statusCode?: number;
}

export interface ScrapedImage {
  url: string;
  originalUrl?: string;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  source?: 'product' | 'detail';
}

export interface RuleAuditResult {
  ruleId: string;
  ruleName: string;
  model: string;
  conclusion: string;
  violations: ViolationItem[];
  analysis: string;
}

export interface AuditResult {
  id: string;
  productLink: ProductLink;
  conclusion: string;
  adultConclusion?: string;
  screeningLabel?: string;
  matchedRuleNames?: string[];
  violations: ViolationItem[];
  analysis: string;
  auditDetail?: string;
  ruleResults?: RuleAuditResult[];
  status: AuditStatus;
  scrapedContent?: ScrapedContent;
  errorMessage?: string;
  timestamp?: number;
}

export interface ViolationItem {
  type: 'image' | 'text';
  category: string;
  description: string;
  evidence: string;
  severity: 'high' | 'medium' | 'low';
}

export interface AuditRule {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  model: string;
  screeningPrompt?: string;
}

export interface ModelOption {
  id: string;
  name: string;
  supportsImage: boolean;
}

export interface AuditRules {
  rules: AuditRule[];
}

export type ModelProvider = 'ark' | 'openai-compatible';

export type FeishuAuthMode = 'tenant' | 'user';

export interface ModelApiConfig {
  provider: ModelProvider;
  apiKey: string;
  endpointId: string;
  modelName: string;
  baseUrl: string;
  modelBaseUrl: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  appToken: string;
  tableId: string;
  authMode?: FeishuAuthMode;
  userAccessToken?: string;
  userRefreshToken?: string;
  userTokenExpiresAt?: number;
  userOpenId?: string;
  userName?: string;
  userGrantedScope?: string;
  bitableUrl?: string;
}

export interface FeishuPushResult {
  success: boolean;
  total: number;
  successCount: number;
  failCount: number;
  details: {
    index: number;
    success: boolean;
    error?: string;
  }[];
  createdFields?: string[];
  bitableUrl?: string;
}

export type BatchSourceType = 'upload' | 'local-path';
export type BatchJobPhase = 'queued' | 'running' | 'completed' | 'failed';

export interface BatchJobProgress {
  totalRows: number;
  deduplicatedRows: number;
  eligibleRows: number;
  processedRows: number;
  skippedRows: number;
  successRows: number;
  failedRows: number;
}

export interface BatchJobConfig {
  jobId: string;
  sourceType: BatchSourceType;
  filePath: string;
  fileName: string;
  createdAt: number;
  serverBaseUrl: string;
  modelConfig: ModelApiConfig;
  feishuConfig: FeishuConfig;
  rules: AuditRules;
}

export interface BatchJobState {
  jobId: string;
  phase: BatchJobPhase;
  step: string;
  message: string;
  progress: BatchJobProgress;
  sourceType: BatchSourceType;
  sourceFilePath: string;
  sourceFileName: string;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  bitableUrl?: string;
  appToken?: string;
  tableId?: string;
}

export type AuditMode = 'web' | 'cmd';
