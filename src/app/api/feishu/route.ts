import { NextRequest, NextResponse } from 'next/server';
import type { AuditResult, FeishuConfig } from '@/lib/types';

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
}

const FIELD_TYPE = {
  TEXT: 1,
  NUMBER: 2,
  SELECT: 3,
  DATETIME: 5,
  URL: 15,
} as const;

const REQUIRED_FIELDS: FieldDefinition[] = [
  { field_name: '产品链接', type: FIELD_TYPE.URL },
  { field_name: '产品名称', type: FIELD_TYPE.TEXT },
  { field_name: 'SKU', type: FIELD_TYPE.TEXT },
  {
    field_name: '审核结论',
    type: FIELD_TYPE.SELECT,
    property: {
      options: [
        { name: '合规', color: 0 },
        { name: '违规', color: 1 },
        { name: '待复核', color: 2 },
      ],
    },
  },
  { field_name: '违规项', type: FIELD_TYPE.TEXT },
  { field_name: '违规数量', type: FIELD_TYPE.NUMBER },
  { field_name: '页面标题', type: FIELD_TYPE.TEXT },
  { field_name: '页面文字内容', type: FIELD_TYPE.TEXT },
  { field_name: '商品素材图', type: FIELD_TYPE.TEXT },
  { field_name: '商品详情图', type: FIELD_TYPE.TEXT },
  { field_name: '图片链接', type: FIELD_TYPE.TEXT },
  { field_name: '审核详情', type: FIELD_TYPE.TEXT },
  { field_name: '审核时间', type: FIELD_TYPE.DATETIME },
];

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
  return options?.includeCode && code !== undefined ? `${core}（code=${code}）` : core;
}

function logFeishuFailure(
  label: string,
  responseStatus: number,
  data: Record<string, unknown> | FeishuOAuthTokenResponse
) {
  console.error(`[Feishu] ${label} failed`, {
    httpStatus: responseStatus,
    code: typeof data.code === 'number' ? data.code : undefined,
    msg: typeof data.msg === 'string' ? data.msg : undefined,
    error: typeof data.error === 'string' ? data.error : undefined,
    error_description:
      typeof data.error_description === 'string' ? data.error_description : undefined,
    has_access_token: typeof data.access_token === 'string',
    has_refresh_token: typeof data.refresh_token === 'string',
  });
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
    logFeishuFailure('getTenantAccessToken', response.status, data);
    throw new Error(
      `飞书认证失败：${getFeishuErrorMessage(data, 'unknown error', {
        includeCode: true,
      })}`
    );
  }

  return data.tenant_access_token;
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
    logFeishuFailure('refreshUserAccessToken', response.status, data);
    throw new Error(
      `刷新飞书用户授权失败：${getFeishuErrorMessage(data, 'unknown error', {
        includeCode: true,
      })}`
    );
  }

  return {
    ...config,
    authMode: 'user',
    userAccessToken: data.access_token,
    userRefreshToken:
      typeof data.refresh_token === 'string' ? data.refresh_token : config.userRefreshToken,
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
      (typeof config.userTokenExpiresAt !== 'number' ||
        config.userTokenExpiresAt > Date.now() + bufferMs)
    ) {
      return { token: config.userAccessToken };
    }

    if (config.userRefreshToken) {
      const updatedConfig = await refreshUserAccessToken(config);
      return { token: updatedConfig.userAccessToken || '', updatedConfig };
    }

    throw new Error(
      '当前配置是用户授权模式，但没有可用的 refresh_token。请先在飞书开放平台开通并发布 `offline_access` 权限，再重新授权。'
    );
  }

  return { token: await getTenantAccessToken(config) };
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
    logFeishuFailure('listFields', response.status, data);
    throw new Error(
      `获取字段列表失败：${getFeishuErrorMessage(data, 'unknown error', {
        includeCode: true,
      })}`
    );
  }

  const fieldMap = new Map<string, { fieldId: string; type: number }>();
  const payload = data.data as
    | { items?: Array<{ field_id: string; field_name: string; type: number }> }
    | undefined;

  for (const field of payload?.items || []) {
    fieldMap.set(field.field_name, { fieldId: field.field_id, type: field.type });
  }

  return fieldMap;
}

async function createField(config: FeishuConfig, token: string, fieldDef: FieldDefinition) {
  const { response, data } = await requestJson<Record<string, unknown>>(
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
    logFeishuFailure('createField', response.status, data);
    throw new Error(
      `创建字段“${fieldDef.field_name}”失败：${getFeishuErrorMessage(data, 'unknown error', {
        includeCode: true,
      })}`
    );
  }
}

async function ensureFields(
  config: FeishuConfig,
  token: string
): Promise<{ existing: string[]; created: string[]; fieldTypes: Map<string, number> }> {
  const existingFields = await listFields(config, token);
  const existing: string[] = [];
  const created: string[] = [];
  const fieldTypes = new Map<string, number>();

  for (const [name, info] of existingFields.entries()) {
    existing.push(name);
    fieldTypes.set(name, info.type);
  }

  for (const fieldDef of REQUIRED_FIELDS) {
    if (existingFields.has(fieldDef.field_name)) continue;
    await createField(config, token, fieldDef);
    created.push(fieldDef.field_name);
    fieldTypes.set(fieldDef.field_name, fieldDef.type);
  }

  return { existing, created, fieldTypes };
}

async function createBitableRecord(
  config: FeishuConfig,
  token: string,
  fields: Record<string, unknown>
) {
  const { response, data } = await requestJson<Record<string, unknown>>(
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
    logFeishuFailure('createBitableRecord', response.status, data);
    throw new Error(
      `飞书写入失败：${getFeishuErrorMessage(data, 'unknown error', {
        includeCode: true,
      })}`
    );
  }

  const payload = data.data as { record?: { record_id?: string } } | undefined;
  return payload?.record?.record_id || '';
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      config: FeishuConfig;
      results: AuditResult[];
    };

    const { config, results } = body;

    if (!config?.appId || !config?.appSecret || !config?.appToken || !config?.tableId) {
      return NextResponse.json(
        { error: '飞书配置不完整，请先完成表格创建或填写表格信息。' },
        { status: 400 }
      );
    }

    if (!results?.length) {
      return NextResponse.json({ error: '没有需要推送的审核结果。' }, { status: 400 });
    }

    const { token, updatedConfig } = await resolveFeishuAccessToken(config);
    const effectiveConfig = updatedConfig || config;
    const fieldStatus = await ensureFields(effectiveConfig, token);

    const pushResults: Array<{ id: string; success: boolean; recordId?: string; error?: string }> = [];

    for (const result of results) {
      try {
        const violationsText = result.violations
          .map(
            (item) =>
              `[${item.severity}] ${item.category}: ${item.description}（证据：${item.evidence}）`
          )
          .join('\n');

        const productImageUrls =
          result.scrapedContent?.productImages
            ?.map((image) => image.originalUrl || image.url)
            .filter(Boolean)
            .join('\n') || '';

        const detailImageUrls =
          result.scrapedContent?.detailImages
            ?.map((image) => image.originalUrl || image.url)
            .filter(Boolean)
            .join('\n') || '';

        const allImageUrls =
          productImageUrls || detailImageUrls
            ? `${productImageUrls}\n${detailImageUrls}`.trim()
            : result.scrapedContent?.images
                ?.map((image) => image.originalUrl || image.url)
                .filter(Boolean)
                .join('\n') || '';

        const rawFields: Record<string, unknown> = {
          产品链接: result.productLink.url,
          产品名称: result.productLink.name || result.scrapedContent?.title || '',
          SKU: result.productLink.sku || '',
          审核结论: result.conclusion || '待复核',
          违规项: violationsText || '无',
          违规数量: result.violations.length,
          页面标题: result.scrapedContent?.title || '',
          页面文字内容: result.scrapedContent?.textContent?.slice(0, 5000) || '',
          商品素材图: productImageUrls,
          商品详情图: detailImageUrls,
          图片链接: allImageUrls,
          审核详情: result.auditDetail?.slice(0, 5000) || result.analysis?.slice(0, 5000) || '',
          审核时间: Math.floor(Date.now() / 1000),
        };

        const fields: Record<string, unknown> = {};
        for (const [fieldName, value] of Object.entries(rawFields)) {
          const fieldType = fieldStatus.fieldTypes.get(fieldName);
          if (fieldType === undefined) continue;

          if (fieldType === FIELD_TYPE.URL && typeof value === 'string') {
            fields[fieldName] = { link: value, text: value };
          } else {
            fields[fieldName] = value;
          }
        }

        const recordId = await createBitableRecord(effectiveConfig, token, fields);
        pushResults.push({ id: result.id, success: true, recordId });
      } catch (error) {
        pushResults.push({
          id: result.id,
          success: false,
          error: error instanceof Error ? error.message : '推送失败',
        });
      }
    }

    const successCount = pushResults.filter((item) => item.success).length;
    const failCount = pushResults.filter((item) => !item.success).length;

    return NextResponse.json({
      success: true,
      total: results.length,
      successCount,
      failCount,
      fieldStatus,
      details: pushResults,
      updatedConfig,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '推送失败';
    return NextResponse.json({ error: `飞书推送失败：${message}` }, { status: 500 });
  }
}
