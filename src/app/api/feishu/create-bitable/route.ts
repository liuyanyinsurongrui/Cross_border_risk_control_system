import { NextRequest, NextResponse } from 'next/server';

const FIELD_TYPE = {
  TEXT: 1,
  NUMBER: 2,
  SINGLE_SELECT: 3,
  DATE: 5,
  URL: 15,
} as const;

type AuthMode = 'tenant' | 'user';

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
}

const CONCLUSION_OPTIONS = [
  { name: '合规', color: 53 },
  { name: '违规', color: 0 },
  { name: '待人工复核', color: 26 },
];

const ALL_FIELDS: FieldDefinition[] = [
  { field_name: '产品链接', type: FIELD_TYPE.URL },
  { field_name: '产品名称', type: FIELD_TYPE.TEXT },
  { field_name: 'SKU', type: FIELD_TYPE.TEXT },
  {
    field_name: '审核结论',
    type: FIELD_TYPE.SINGLE_SELECT,
    property: {
      options: CONCLUSION_OPTIONS.map((option) => ({
        name: option.name,
        color: option.color,
      })),
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
  {
    field_name: '审核时间',
    type: FIELD_TYPE.DATE,
    property: { date_formatter: 'yyyy/MM/dd HH:mm' },
  },
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
    scope: typeof data.scope === 'string' ? data.scope : undefined,
    token_type: typeof data.token_type === 'string' ? data.token_type : undefined,
    has_access_token: typeof data.access_token === 'string',
    has_refresh_token: typeof data.refresh_token === 'string',
  });
}

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const { response, data } = await requestJson<Record<string, unknown>>(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    }
  );

  if (data.code !== 0 || typeof data.tenant_access_token !== 'string') {
    logFeishuFailure('getTenantAccessToken', response.status, data);
    throw new Error(
      `获取 tenant_access_token 失败：${getFeishuErrorMessage(data, 'unknown error', {
        includeCode: true,
      })}`
    );
  }

  return data.tenant_access_token;
}

async function getUserAccessTokenByCode(
  appId: string,
  appSecret: string,
  code: string,
  redirectUri: string
): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope?: string;
  openId?: string;
  name?: string;
}> {
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
    logFeishuFailure('getUserAccessTokenByCode', response.status, data);
    throw new Error(
      `获取用户授权失败：${getFeishuErrorMessage(data, 'unknown error', {
        includeCode: true,
      })}`
    );
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

async function createBitableApp(token: string, name: string): Promise<{ appToken: string; url: string }> {
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
    logFeishuFailure('createBitableApp', response.status, data);
    throw new Error(
      `创建多维表格失败：${getFeishuErrorMessage(data, 'unknown error', {
        includeCode: true,
      })}`
    );
  }

  return {
    appToken: app.app_token,
    url: app.url || '',
  };
}

async function listBitableTables(
  token: string,
  appToken: string
): Promise<Array<{ table_id: string; name: string }>> {
  const { response, data } = await requestJson<Record<string, unknown>>(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (data.code !== 0) {
    logFeishuFailure('listBitableTables', response.status, data);
    throw new Error(
      `获取数据表列表失败：${getFeishuErrorMessage(data, 'unknown error', {
        includeCode: true,
      })}`
    );
  }

  const payload = data.data as { items?: Array<{ table_id: string; name: string }> } | undefined;
  return payload?.items || [];
}

async function createBitableTable(
  token: string,
  appToken: string,
  tableName: string,
  fields: FieldDefinition[]
): Promise<{ tableId: string; tableName: string }> {
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

  const payload = data.data as
    | {
        table?: { table_id?: string; name?: string };
        table_id?: string;
      }
    | undefined;
  const table = payload?.table;
  const tableId = table?.table_id || payload?.table_id;

  if (data.code !== 0) {
    logFeishuFailure('createBitableTable', response.status, data);
    throw new Error(
      `创建数据表失败：${getFeishuErrorMessage(data, 'unknown error', {
        includeCode: true,
      })}`
    );
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

async function deleteDefaultTable(token: string, appToken: string, tableId: string): Promise<void> {
  const { response, data } = await requestJson<Record<string, unknown>>(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  if (data.code !== 0) {
    console.warn('[Feishu] deleteDefaultTable skipped', {
      httpStatus: response.status,
      tableId,
      message: getFeishuErrorMessage(data, 'unknown error', { includeCode: true }),
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      appId: string;
      appSecret: string;
      authMode?: AuthMode;
      code?: string;
      redirectUri?: string;
    };

    const { appId, appSecret, authMode = 'tenant', code, redirectUri } = body;

    if (!appId || !appSecret) {
      return NextResponse.json({ error: '请先填写 App ID 和 App Secret' }, { status: 400 });
    }

    if (authMode === 'user' && (!code || !redirectUri)) {
      return NextResponse.json(
        { error: '缺少授权码或回调地址，请重新点击“授权并创建多维表格”' },
        { status: 400 }
      );
    }

    let token = '';
    const userAuth =
      authMode === 'user' && code && redirectUri
        ? await getUserAccessTokenByCode(appId, appSecret, code, redirectUri)
        : null;

    token = userAuth ? userAuth.accessToken : await getTenantAccessToken(appId, appSecret);

    const app = await createBitableApp(token, '跨境电商链接违规审核');
    const existingTables = await listBitableTables(token, app.appToken);

    for (const table of existingTables) {
      if (table.name !== '审核数据') {
        await deleteDefaultTable(token, app.appToken, table.table_id);
      }
    }

    const table = await createBitableTable(token, app.appToken, '审核数据', ALL_FIELDS);

    const warning =
      authMode === 'user' && userAuth && !userAuth.refreshToken
        ? '已完成本次用户授权创建，但当前没有拿到 refresh_token。请在飞书开放平台为应用开通并发布 `offline_access` 权限后重新授权，否则后续用户身份推送在 access_token 过期后需要重新授权。'
        : undefined;

    return NextResponse.json({
      success: true,
      authMode,
      appToken: app.appToken,
      tableId: table.tableId,
      tableName: table.tableName,
      bitableUrl: app.url,
      warning,
      userAccessToken: userAuth?.accessToken,
      userRefreshToken: userAuth?.refreshToken,
      userTokenExpiresAt: userAuth ? Date.now() + userAuth.expiresIn * 1000 : undefined,
      userOpenId: userAuth?.openId,
      userName: userAuth?.name,
      userGrantedScope: userAuth?.scope,
      fields: ALL_FIELDS.map((field) => ({
        name: field.field_name,
        type: field.type,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '创建多维表格失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
