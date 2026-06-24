import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import type { AuditResult, FeishuConfig, FeishuPushResult } from '@/lib/types';

const execFileAsync = promisify(execFile);

interface FieldDefinition {
  field_name: string;
  type: number;
  property?: Record<string, unknown>;
}

interface FeishuOAuthTokenResponse {
  code?: number;
  msg?: string;
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  open_id?: string;
  name?: string;
  tenant_access_token?: string;
}

export const FIELD_TYPE = {
  TEXT: 1,
  NUMBER: 2,
  SINGLE_SELECT: 3,
  DATE: 5,
  CREATED_TIME: 1001,
  ATTACHMENT: 17,
  URL: 15,
} as const;

const IMAGE_DOWNLOAD_TIMEOUT_MS = 12000;
const ATTACHMENT_UPLOAD_CONCURRENCY = 4;
const MAX_FEISHU_ATTACHMENT_IMAGES = 12;
const MAX_FEISHU_PRODUCT_ATTACHMENTS = 6;
const MAX_FEISHU_DETAIL_ATTACHMENTS = 6;
const FEISHU_SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
]);

const ALL_FIELDS: FieldDefinition[] = [
  { field_name: '产品名称', type: FIELD_TYPE.TEXT },
  { field_name: '落地页链接', type: FIELD_TYPE.URL },
  { field_name: '部门', type: FIELD_TYPE.TEXT },
  { field_name: '虚拟SKU编号', type: FIELD_TYPE.TEXT },
  { field_name: '真实SKU编号', type: FIELD_TYPE.TEXT },
  { field_name: '运营', type: FIELD_TYPE.TEXT },
  { field_name: '订单数', type: FIELD_TYPE.NUMBER },
  { field_name: '落地页文字', type: FIELD_TYPE.TEXT },
  { field_name: '落地页图片', type: FIELD_TYPE.ATTACHMENT },
  { field_name: '审核标签', type: FIELD_TYPE.TEXT },
  { field_name: '产品审核结果', type: FIELD_TYPE.TEXT },
  { field_name: '产品判断依据', type: FIELD_TYPE.TEXT },
  {
    field_name: '审核时间',
    type: FIELD_TYPE.DATE,
    property: { date_formatter: 'yyyy/MM/dd HH:mm' },
  },
];

const LEGACY_FIELD_ALIASES = {
  落地页链接: ['链接', '第三方域名链接'],
  虚拟SKU编号: ['虚拟SPU'],
  真实SKU编号: ['真实SPU'],
  落地页文字: ['落地页文字内容'],
  落地页图片: ['落地页图片内容'],
  审核标签: ['产品名称意图识别'],
  产品判断依据: [
    '产品判定依据',
    '产品审核思考过程',
    '宣传审核思考过程',
    '文字审核思考过程',
    '图片审核思考过程',
    '侵权文字',
  ],
  产品审核结果: ['宣传审核结果', '审核状态', '是否侵权', '处理方式'],
} as const;

interface UploadedAttachment {
  file_token: string;
  name?: string;
  type?: string;
  size?: number;
  url?: string;
  tmp_url?: string;
}

function createLimiter(concurrency: number) {
  const safeConcurrency = Math.max(1, concurrency);
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const releaseNext = () => {
    activeCount -= 1;
    const nextTask = queue.shift();
    nextTask?.();
  };

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (activeCount >= safeConcurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }

    activeCount += 1;
    try {
      return await task();
    } finally {
      releaseNext();
    }
  };
}

function dedupeImageUrls(urls: string[]) {
  return Array.from(
    new Set(
      urls
        .map((url) => url.trim())
        .filter(Boolean)
    )
  );
}

function guessExtensionFromMimeType(mimeType: string) {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('avif')) return 'avif';
  if (normalized.includes('gif')) return 'gif';
  return 'jpg';
}

function buildImageFileName(imageUrl: string, index: number, mimeType: string) {
  try {
    const parsed = new URL(imageUrl);
    const lastSegment = parsed.pathname.split('/').filter(Boolean).at(-1) || `image-${index + 1}`;
    const safeName = lastSegment.replace(/[<>:"/\\|?*]+/g, '-').slice(0, 80);
    if (/\.[a-z0-9]{2,5}$/i.test(safeName)) {
      return safeName;
    }
    return `${safeName}.${guessExtensionFromMimeType(mimeType)}`;
  } catch {
    return `image-${index + 1}.${guessExtensionFromMimeType(mimeType)}`;
  }
}

async function requestJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const text = await response.text();

  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    throw new Error(`飞书接口返回了无法解析的响应（HTTP ${response.status}）`);
  }

  return { response, data };
}

function getFeishuErrorMessage(
  data: Record<string, unknown> | FeishuOAuthTokenResponse,
  fallback: string,
  options?: { includeCode?: boolean }
) {
  const code = typeof data.code === 'number' ? data.code : undefined;
  const description =
    typeof data.error_description === 'string' && data.error_description.trim()
      ? data.error_description.trim()
      : '';
  const message =
    typeof data.msg === 'string' && data.msg.trim()
      ? data.msg.trim()
      : typeof data.error === 'string' && data.error.trim()
        ? data.error.trim()
        : '';

  const core = description || message || fallback;

  if (
    core.toLowerCase().includes('refresh token has been revoked') ||
    code === 20064
  ) {
    return '飞书用户授权已失效，请重新点击“仅授权飞书用户”完成授权后再试';
  }

  return options?.includeCode && code !== undefined ? `${core}(code=${code})` : core;
}

async function getTenantAccessToken(config: FeishuConfig): Promise<string> {
  const { response, data } = await requestJson<Record<string, unknown>>(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: config.appId,
        app_secret: config.appSecret,
      }),
    }
  );

  if (data.code !== 0 || typeof data.tenant_access_token !== 'string') {
    throw new Error(`飞书鉴权失败：${getFeishuErrorMessage(data, 'unknown error', { includeCode: true })}`);
  }

  return data.tenant_access_token;
}

async function getUserAccessTokenByCode(
  appId: string,
  appSecret: string,
  code: string,
  redirectUri: string
) {
  const { response, data } = await requestJson<FeishuOAuthTokenResponse>(
    'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
      }),
    }
  );

  if (data.code !== 0 || typeof data.access_token !== 'string') {
    throw new Error(`获取用户授权失败：${getFeishuErrorMessage(data, 'unknown error', { includeCode: true })}`);
  }

  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : undefined,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : 7200,
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    openId: typeof data.open_id === 'string' ? data.open_id : undefined,
    name: typeof data.name === 'string' ? data.name : undefined,
  };
}

export async function authorizeFeishuUser(params: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
  existingConfig?: Partial<FeishuConfig>;
}) {
  const { appId, appSecret, code, redirectUri, existingConfig } = params;

  if (!appId || !appSecret || !code || !redirectUri) {
    throw new Error('缺少飞书授权所需参数');
  }

  const userAuth = await getUserAccessTokenByCode(appId, appSecret, code, redirectUri);

  return {
    appId,
    appSecret,
    appToken: existingConfig?.appToken || '',
    tableId: existingConfig?.tableId || '',
    authMode: 'user' as const,
    userAccessToken: userAuth.accessToken,
    userRefreshToken: userAuth.refreshToken,
    userTokenExpiresAt: Date.now() + userAuth.expiresIn * 1000,
    userOpenId: userAuth.openId,
    userName: userAuth.name,
    userGrantedScope: userAuth.scope,
    bitableUrl: existingConfig?.bitableUrl || '',
  };
}

async function refreshUserAccessToken(config: FeishuConfig): Promise<FeishuConfig> {
  if (!config.userRefreshToken) {
    throw new Error('当前飞书用户授权已失效，请重新授权。');
  }

  const { response, data } = await requestJson<FeishuOAuthTokenResponse>(
    'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: config.userRefreshToken,
        client_id: config.appId,
        client_secret: config.appSecret,
      }),
    }
  );

  if (data.code !== 0 || typeof data.access_token !== 'string') {
    throw new Error(`刷新飞书用户授权失败：${getFeishuErrorMessage(data, 'unknown error', { includeCode: true })}`);
  }

  return {
    ...config,
    authMode: 'user',
    userAccessToken: data.access_token,
    userRefreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : config.userRefreshToken,
    userTokenExpiresAt:
      Date.now() + (typeof data.expires_in === 'number' ? data.expires_in : 7200) * 1000,
  };
}

async function resolveFeishuAccessToken(
  config: FeishuConfig
): Promise<{ token: string; updatedConfig?: FeishuConfig }> {
  if (config.authMode === 'user') {
    const bufferMs = 5 * 60 * 1000;

    if (
      config.userAccessToken &&
      (typeof config.userTokenExpiresAt !== 'number' || config.userTokenExpiresAt > Date.now() + bufferMs)
    ) {
      return { token: config.userAccessToken };
    }

    if (config.userRefreshToken) {
      const updatedConfig = await refreshUserAccessToken(config);
      return { token: updatedConfig.userAccessToken || '', updatedConfig };
    }

    throw new Error('当前配置是用户授权模式，但没有可用的 refresh_token，请重新授权。');
  }

  return { token: await getTenantAccessToken(config) };
}

export async function resolveFeishuConfig(
  config: FeishuConfig
): Promise<{ token: string; config: FeishuConfig }> {
  const { token, updatedConfig } = await resolveFeishuAccessToken(config);
  return {
    token,
    config: updatedConfig || config,
  };
}

async function createBitableApp(token: string, name: string) {
  const { response, data } = await requestJson<Record<string, unknown>>(
    'https://open.feishu.cn/open-apis/bitable/v1/apps',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name }),
    }
  );

  const payload = data.data as { app?: { app_token?: string; url?: string } } | undefined;
  const app = payload?.app;
  if (data.code !== 0 || !app?.app_token) {
    throw new Error(`创建多维表格失败：${getFeishuErrorMessage(data, 'unknown error', { includeCode: true })}`);
  }

  return {
    appToken: app.app_token,
    url: app.url || '',
  };
}

async function listBitableTables(token: string, appToken: string) {
  const { response, data } = await requestJson<Record<string, unknown>>(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (data.code !== 0) {
    throw new Error(`获取数据表列表失败：${getFeishuErrorMessage(data, 'unknown error', { includeCode: true })}`);
  }

  const payload = data.data as { items?: Array<{ table_id: string; name: string }> } | undefined;
  return payload?.items || [];
}

async function createBitableTable(
  token: string,
  appToken: string,
  tableName: string,
  fields: FieldDefinition[]
) {
  const { response, data } = await requestJson<Record<string, unknown>>(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        table: {
          name: tableName,
          default_view_name: '审核结果',
          fields: fields.map((field) => ({
            field_name: field.field_name,
            type: field.type,
            ...(field.property ? { property: field.property } : {}),
          })),
        },
      }),
    }
  );

  const payload = data.data as { table?: { table_id?: string; name?: string }; table_id?: string } | undefined;
  const table = payload?.table;
  const tableId = table?.table_id || payload?.table_id;

  if (data.code !== 0) {
    throw new Error(`创建数据表失败：${getFeishuErrorMessage(data, 'unknown error', { includeCode: true })}`);
  }

  if (tableId) {
    return { tableId, tableName: table?.name || tableName };
  }

  const tables = await listBitableTables(token, appToken);
  const matchedTable = tables.find((item) => item.name === tableName) || tables.at(-1);
  if (!matchedTable) {
    throw new Error('创建数据表成功，但未找到表 ID');
  }

  return { tableId: matchedTable.table_id, tableName: matchedTable.name };
}

async function deleteDefaultTable(token: string, appToken: string, tableId: string) {
  const { data } = await requestJson<Record<string, unknown>>(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (data.code !== 0) {
    console.warn('[Feishu] deleteDefaultTable skipped', { tableId });
  }
}

async function listFields(
  config: FeishuConfig,
  token: string
): Promise<Map<string, { fieldId: string; type: number }>> {
  const { response, data } = await requestJson<Record<string, unknown>>(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/fields`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (data.code !== 0) {
    throw new Error(`获取字段列表失败：${getFeishuErrorMessage(data, 'unknown error', { includeCode: true })}`);
  }

  const fieldMap = new Map<string, { fieldId: string; type: number }>();
  const payload = data.data as { items?: Array<{ field_id: string; field_name: string; type: number }> } | undefined;

  for (const field of payload?.items || []) {
    fieldMap.set(field.field_name, { fieldId: field.field_id, type: field.type });
  }

  return fieldMap;
}

async function createField(config: FeishuConfig, token: string, fieldDef: FieldDefinition) {
  const { data } = await requestJson<Record<string, unknown>>(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/fields`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(fieldDef),
    }
  );

  if (data.code !== 0) {
    throw new Error(`创建字段“${fieldDef.field_name}”失败：${getFeishuErrorMessage(data, 'unknown error', { includeCode: true })}`);
  }
}

async function ensureFields(config: FeishuConfig, token: string) {
  const existingFields = await listFields(config, token);
  const created: string[] = [];
  const fieldTypes = new Map<string, number>();

  for (const [name, info] of existingFields.entries()) {
    fieldTypes.set(name, info.type);
  }

  for (const fieldDef of ALL_FIELDS) {
    if (existingFields.has(fieldDef.field_name)) continue;
    await createField(config, token, fieldDef);
    created.push(fieldDef.field_name);
    fieldTypes.set(fieldDef.field_name, fieldDef.type);
  }

  return { created, fieldTypes };
}

async function createBitableRecord(
  config: FeishuConfig,
  token: string,
  fields: Record<string, unknown>
) {
  const { data } = await requestJson<Record<string, unknown>>(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${config.appToken}/tables/${config.tableId}/records`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ fields }),
    }
  );

  if (data.code !== 0) {
    throw new Error(`写入飞书失败：${getFeishuErrorMessage(data, 'unknown error', { includeCode: true })}`);
  }
}

function shouldConvertImageForFeishu(mimeType: string, fileName: string) {
  const normalizedMimeType = mimeType.toLowerCase().split(';')[0].trim();
  if (FEISHU_SUPPORTED_IMAGE_MIME_TYPES.has(normalizedMimeType)) {
    return false;
  }

  return /\.(webp|avif|svg)$/i.test(fileName) || Boolean(normalizedMimeType);
}

async function convertImageForFeishu(file: { bytes: Buffer; mimeType: string; fileName: string }) {
  const tempDir = path.join(os.tmpdir(), 'audit-feishu-image-convert');
  await fs.mkdir(tempDir, { recursive: true });

  const inputPath = path.join(tempDir, `${randomUUID()}-${file.fileName}`);
  const outputPath = path.join(tempDir, `${randomUUID()}.png`);

  try {
    await fs.writeFile(inputPath, file.bytes);
    const script = [
      'from PIL import Image',
      'import sys',
      'input_path, output_path = sys.argv[1], sys.argv[2]',
      'image = Image.open(input_path)',
      'if image.mode not in ("RGB", "RGBA"):',
      '    image = image.convert("RGBA" if "A" in image.mode else "RGB")',
      'if image.mode == "RGBA":',
      '    image.save(output_path, format="PNG")',
      'else:',
      '    image.convert("RGB").save(output_path, format="PNG")',
    ].join('\n');

    await execFileAsync('python', ['-c', script, inputPath, outputPath], {
      windowsHide: true,
      timeout: IMAGE_DOWNLOAD_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });

    const outputBytes = await fs.readFile(outputPath);
    const outputFileName = file.fileName.replace(/\.[a-z0-9]{2,5}$/i, '') + '.png';

    return {
      bytes: outputBytes,
      mimeType: 'image/png',
      fileName: outputFileName,
    };
  } finally {
    await Promise.allSettled([fs.rm(inputPath, { force: true }), fs.rm(outputPath, { force: true })]);
  }
}

async function downloadImageForFeishu(imageUrl: string, index: number) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(imageUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        Referer: imageUrl,
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`下载图片失败（HTTP ${response.status}）`);
    }

    const mimeType = response.headers.get('content-type') || 'image/jpeg';
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length) {
      throw new Error('下载图片失败（空内容）');
    }

    const downloadedFile = {
      bytes,
      mimeType,
      fileName: buildImageFileName(imageUrl, index, mimeType),
    };

    if (shouldConvertImageForFeishu(downloadedFile.mimeType, downloadedFile.fileName)) {
      return await convertImageForFeishu(downloadedFile);
    }

    return downloadedFile;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function uploadBitableImage(
  token: string,
  appToken: string,
  file: { bytes: Buffer; mimeType: string; fileName: string }
) {
  const form = new FormData();
  form.set('file_name', file.fileName);
  form.set('parent_type', 'bitable_image');
  form.set('parent_node', appToken);
  form.set('size', String(file.bytes.byteLength));
  const blobBytes = new Uint8Array(file.bytes);
  form.set('file', new Blob([blobBytes], { type: file.mimeType }), file.fileName);

  const { data } = await requestJson<Record<string, unknown>>(
    'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: form,
    }
  );

  const payload = data.data as UploadedAttachment | undefined;
  if (data.code !== 0 || !payload?.file_token) {
    throw new Error(`上传飞书图片失败：${getFeishuErrorMessage(data, 'unknown error', { includeCode: true })}`);
  }

  return payload;
}

function isFeishuRateLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return message.includes('99991400') || /frequency limit/i.test(message);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadBitableImageWithRetry(
  token: string,
  appToken: string,
  file: { bytes: Buffer; mimeType: string; fileName: string }
) {
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await uploadBitableImage(token, appToken, file);
    } catch (error) {
      if (!isFeishuRateLimitError(error) || attempt === maxAttempts) {
        throw error;
      }

      await sleep(800 * attempt);
    }
  }

  throw new Error('上传飞书图片失败');
}

function collectResultImageUrls(result: AuditResult) {
  const productUrls = dedupeImageUrls(
    (result.scrapedContent?.productImages ?? [])
      .map((image) => image.originalUrl || image.url)
      .filter((value): value is string => Boolean(value && value.trim()))
  ).slice(0, MAX_FEISHU_PRODUCT_ATTACHMENTS);

  const detailUrls = dedupeImageUrls(
    (result.scrapedContent?.detailImages ?? [])
      .map((image) => image.originalUrl || image.url)
      .filter((value): value is string => Boolean(value && value.trim()))
  ).slice(0, MAX_FEISHU_DETAIL_ATTACHMENTS);

  const fallbackUrls = dedupeImageUrls(
    (result.scrapedContent?.images ?? [])
      .map((image) => image.originalUrl || image.url)
      .filter((value): value is string => Boolean(value && value.trim()))
  );

  const mergedUrls = dedupeImageUrls([...productUrls, ...detailUrls]);
  if (mergedUrls.length >= MAX_FEISHU_ATTACHMENT_IMAGES) {
    return mergedUrls.slice(0, MAX_FEISHU_ATTACHMENT_IMAGES);
  }

  return dedupeImageUrls([...mergedUrls, ...fallbackUrls]).slice(0, MAX_FEISHU_ATTACHMENT_IMAGES);
}

async function uploadResultImagesToFeishu(
  token: string,
  appToken: string,
  result: AuditResult
): Promise<UploadedAttachment[]> {
  const imageUrls = collectResultImageUrls(result);
  if (imageUrls.length === 0) {
    return [];
  }

  const limit = createLimiter(ATTACHMENT_UPLOAD_CONCURRENCY);
  const uploads = await Promise.all(
    imageUrls.map((imageUrl, index) =>
      limit(async () => {
        try {
          const file = await downloadImageForFeishu(imageUrl, index);
          return await uploadBitableImageWithRetry(token, appToken, file);
        } catch (error) {
          console.warn('[Feishu] image attachment skipped', {
            imageUrl,
            error: error instanceof Error ? error.message : error,
          });
          return null;
        }
      })
    )
  );

  return uploads.filter((item): item is UploadedAttachment => Boolean(item?.file_token));
}

function shouldSkipFieldWrite(fieldType: number) {
  return fieldType === FIELD_TYPE.CREATED_TIME;
}

function normalizeFieldValueByType(fieldType: number, value: unknown) {
  if (shouldSkipFieldWrite(fieldType)) {
    return undefined;
  }

  if (fieldType === FIELD_TYPE.URL) {
    const text = typeof value === 'string' ? value : String(value ?? '').trim();
    return text ? { link: text, text } : '';
  }

  if (fieldType === FIELD_TYPE.ATTACHMENT) {
    return Array.isArray(value) ? value : [];
  }

  if (fieldType === FIELD_TYPE.NUMBER) {
    const numericValue =
      typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^\d.-]/g, ''));
    return Number.isFinite(numericValue) ? numericValue : 0;
  }

  if (fieldType === FIELD_TYPE.TEXT || fieldType === FIELD_TYPE.SINGLE_SELECT) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    if (Array.isArray(value)) return value.join('、');
    if (typeof value === 'object' && 'link' in (value as Record<string, unknown>)) {
      return String((value as { link?: unknown }).link ?? '');
    }
    return String(value);
  }

  return value;
}

function buildBitableRecordFields(
  result: AuditResult,
  fieldTypes: Map<string, number>,
  imageAttachments: UploadedAttachment[]
) {
  const rawRow = result.productLink.rawRow || {};
  const toText = (value: unknown) => (value == null ? '' : String(value).trim());
  const matchedRuleText = result.screeningLabel || (result.matchedRuleNames || []).join('、');
  const productConclusion = result.adultConclusion || result.conclusion || '待人工复核';
  const productAnalysis = result.auditDetail?.slice(0, 5000) || result.analysis?.slice(0, 5000) || '';
  const normalizedViolations = result.violations || [];
  const textViolations = normalizedViolations.filter((item) => item.type === 'text');
  const imageViolations = normalizedViolations.filter((item) => item.type === 'image');
  const hasViolation = productConclusion.includes('违规');
  const legacyReviewState =
    result.status === 'error'
      ? '处理失败'
      : result.status === 'fetched'
        ? '已抓取'
        : result.status === 'unaudited'
          ? '未审核'
          : result.status === 'review'
            ? '需人工处理'
            : result.status === 'violated'
              ? '已审核'
              : result.status === 'passed'
                ? '已审核'
                : '';
  const orderCountRaw =
    rawRow['订单数'] ??
    rawRow['璁㈠崟鏁?'] ??
    rawRow['order_count'] ??
    rawRow['orders'] ??
    '';
  const orderCount = Number(String(orderCountRaw).replace(/[^\d.-]/g, ''));

  const rawFields: Record<string, unknown> = {
    产品名称: result.productLink.name || result.scrapedContent?.title || '',
    落地页链接: result.productLink.url,
    部门: toText(rawRow['部门']),
    虚拟SKU编号: toText(rawRow['虚拟SKU编号'] ?? result.productLink.sku),
    真实SKU编号: toText(rawRow['真实SKU编号']),
    运营: toText(rawRow['运营']),
    订单数: Number.isFinite(orderCount) ? orderCount : 0,
    落地页文字: result.scrapedContent?.textContent?.slice(0, 5000) || '',
    落地页图片: imageAttachments,
    审核标签: matchedRuleText,
    产品审核结果: productConclusion,
    产品判断依据: productAnalysis,
    审核时间: Date.now(),
  };

  const legacyFallbackFields: Record<string, unknown> = {
    链接: result.productLink.url,
    第三方域名链接: toText(rawRow['第三方域名链接'] ?? result.productLink.url),
    虚拟SPU: toText(rawRow['虚拟SPU'] ?? rawRow['虚拟SKU编号'] ?? result.productLink.sku),
    真实SPU: toText(rawRow['真实SPU'] ?? rawRow['真实SKU编号']),
    落地页文字内容: result.scrapedContent?.textContent?.slice(0, 5000) || '',
    落地页图片内容: imageAttachments,
    产品名称意图识别: matchedRuleText,
    产品判定依据: productAnalysis,
    产品审核思考过程: productAnalysis,
    宣传审核结果:
      textViolations.length > 0 ? '宣传违规' : productConclusion === '产品通过' || productConclusion === '合规' ? '宣传通过' : '需人工处理',
    宣传审核思考过程:
      textViolations.map((item) => item.description || item.evidence).filter(Boolean).join('；').slice(0, 5000) ||
      productAnalysis,
    审核状态: legacyReviewState,
    是否侵权: hasViolation ? '是' : productConclusion === '产品通过' || productConclusion === '合规' ? '否' : '需人工处理',
    侵权文字: textViolations.map((item) => item.evidence || item.description).filter(Boolean).join('；').slice(0, 5000),
    文字审核思考过程:
      textViolations.map((item) => item.description || item.evidence).filter(Boolean).join('；').slice(0, 5000) ||
      productAnalysis,
    图片审核思考过程:
      imageViolations.map((item) => item.description || item.evidence).filter(Boolean).join('；').slice(0, 5000) ||
      productAnalysis,
    处理方式:
      productConclusion.includes('违规') ? '删除' : productConclusion === '产品通过' || productConclusion === '合规' ? '保留' : '人工核查',
  };

  const fields: Record<string, unknown> = {};
  for (const [fieldName, value] of Object.entries(rawFields)) {
    const fieldType = fieldTypes.get(fieldName);
    if (fieldType === undefined) continue;
    const normalizedValue = normalizeFieldValueByType(fieldType, value);
    if (normalizedValue === undefined) continue;
    fields[fieldName] = normalizedValue;
  }

  for (const [primaryField, aliases] of Object.entries(LEGACY_FIELD_ALIASES)) {
    if (fields[primaryField] !== undefined) continue;

    for (const alias of aliases) {
      const fieldType = fieldTypes.get(alias);
      if (fieldType === undefined) continue;
      const aliasValue = legacyFallbackFields[alias];
      const normalizedValue = normalizeFieldValueByType(fieldType, aliasValue);
      if (normalizedValue === undefined) continue;
      fields[alias] = normalizedValue;
    }
  }

  return fields;
}

export async function createFeishuRecordWriter(config: FeishuConfig): Promise<{
  config: FeishuConfig;
  updatedConfig?: FeishuConfig;
  createdFields: string[];
  pushResult: (result: AuditResult) => Promise<void>;
}> {
  if (!config?.appId || !config?.appSecret || !config?.appToken || !config?.tableId) {
    throw new Error('飞书配置不完整，请先完成表格创建或填写表格信息。');
  }

  const { token, updatedConfig } = await resolveFeishuAccessToken(config);
  const effectiveConfig = updatedConfig || config;
  const fieldStatus = await ensureFields(effectiveConfig, token);

  return {
    config: effectiveConfig,
    updatedConfig,
    createdFields: fieldStatus.created,
    pushResult: async (result: AuditResult) => {
      const imageAttachments = await uploadResultImagesToFeishu(
        token,
        effectiveConfig.appToken,
        result
      );
      const fields = buildBitableRecordFields(result, fieldStatus.fieldTypes, imageAttachments);
      await createBitableRecord(effectiveConfig, token, fields);
    },
  };
}

function buildDailyBitableName(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function createDailyBitable(params: {
  appId: string;
  appSecret: string;
  authMode?: 'tenant' | 'user';
  code?: string;
  redirectUri?: string;
  baseName?: string;
  userAccessToken?: string;
  userRefreshToken?: string;
  userTokenExpiresAt?: number;
  userOpenId?: string;
  userName?: string;
  userGrantedScope?: string;
}) {
  const {
    appId,
    appSecret,
    authMode = 'tenant',
    code,
    redirectUri,
    baseName,
    userAccessToken,
    userRefreshToken,
    userTokenExpiresAt,
    userOpenId,
    userName,
    userGrantedScope,
  } = params;

  if (!appId || !appSecret) {
    throw new Error('请先填写 App ID 和 App Secret');
  }

  const hasUserAuthCode = Boolean(code && redirectUri);
  const hasSavedUserAuth = Boolean(userAccessToken || userRefreshToken);

  if (authMode === 'user' && !hasUserAuthCode && !hasSavedUserAuth) {
    throw new Error('缺少授权码或回调地址，请重新完成飞书授权');
  }

  const userAuth =
    authMode === 'user' && code && redirectUri
      ? await getUserAccessTokenByCode(appId, appSecret, code, redirectUri)
      : null;

  const baseConfig: FeishuConfig = {
    appId,
    appSecret,
    appToken: '',
    tableId: '',
    authMode,
    userAccessToken,
    userRefreshToken,
    userTokenExpiresAt,
    userOpenId,
    userName,
    userGrantedScope,
  };

  const authConfig: FeishuConfig = {
    ...baseConfig,
    ...(userAuth
      ? {
          authMode: 'user' as const,
          userAccessToken: userAuth.accessToken,
          userRefreshToken: userAuth.refreshToken,
          userTokenExpiresAt: Date.now() + userAuth.expiresIn * 1000,
          userOpenId: userAuth.openId,
          userName: userAuth.name,
          userGrantedScope: userAuth.scope,
        }
      : {}),
  };

  const resolvedAuth =
    authMode === 'user'
      ? await resolveFeishuAccessToken(authConfig)
      : { token: await getTenantAccessToken(baseConfig) };

  const token = resolvedAuth.token;

  const app = await createBitableApp(token, baseName || '跨境电商链接违规审核');
  const existingTables = await listBitableTables(token, app.appToken);

  for (const table of existingTables) {
    if (table.name !== '审核数据') {
      await deleteDefaultTable(token, app.appToken, table.table_id);
    }
  }

  const table = await createBitableTable(token, app.appToken, buildDailyBitableName(), ALL_FIELDS);
  const config: FeishuConfig = {
    ...(resolvedAuth.updatedConfig || authConfig),
    appToken: app.appToken,
    tableId: table.tableId,
    bitableUrl: app.url,
  };

  return {
    config,
    tableName: table.tableName,
    bitableUrl: app.url,
    warning:
      authMode === 'user' && userAuth && !userAuth.refreshToken
        ? '本次已完成用户授权建表，但当前没有拿到 refresh_token，后续 access_token 过期后需要重新授权。'
        : undefined,
  };
}

export async function pushAuditResultsToFeishu(
  config: FeishuConfig,
  results: AuditResult[]
): Promise<{ updatedConfig?: FeishuConfig } & FeishuPushResult> {
  if (!results.length) {
    throw new Error('没有需要推送的审核结果。');
  }

  const writer = await createFeishuRecordWriter(config);
  const pushResults: Array<{ index: number; success: boolean; error?: string }> = [];

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    try {
      await writer.pushResult(result);
      pushResults.push({ index, success: true });
    } catch (error) {
      pushResults.push({
        index,
        success: false,
        error: error instanceof Error ? error.message : '推送失败',
      });
    }
  }

  const successCount = pushResults.filter((item) => item.success).length;
  const failCount = pushResults.filter((item) => !item.success).length;

  return {
    success: failCount === 0,
    total: results.length,
    successCount,
    failCount,
    details: pushResults,
    createdFields: writer.createdFields,
    bitableUrl: writer.config.bitableUrl,
    updatedConfig: writer.updatedConfig,
  };
}
