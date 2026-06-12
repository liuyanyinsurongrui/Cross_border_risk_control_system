'use client';

import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Save,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type { FeishuConfig } from '@/lib/types';

interface FeishuConfigDialogProps {
  config: FeishuConfig | null;
  onSave: (config: FeishuConfig) => void;
}

interface CreateResponse {
  success?: boolean;
  error?: string;
  warning?: string;
  authMode?: 'tenant' | 'user';
  appToken?: string;
  tableId?: string;
  tableName?: string;
  bitableUrl?: string;
  userAccessToken?: string;
  userRefreshToken?: string;
  userTokenExpiresAt?: number;
  userOpenId?: string;
  userName?: string;
  userGrantedScope?: string;
  fields?: Array<{ name: string; type: number }>;
}

interface OAuthResultPayload {
  type: 'feishu-oauth-result';
  code: string;
  state: string;
  error: string;
  errorDescription: string;
}

const STORAGE_KEY = 'audit_feishu_config';
const OAUTH_RESULT_KEY = 'audit_feishu_oauth_result';
const OAUTH_STATE_KEY = 'audit_feishu_oauth_state';
const OAUTH_SCOPE = 'offline_access bitable:app';

function buildRedirectUri() {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/?feishu_oauth=1`;
}

function buildAuthorizeUrl(appId: string, state: string) {
  const authorizeUrl = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
  authorizeUrl.searchParams.set('client_id', appId);
  authorizeUrl.searchParams.set('redirect_uri', buildRedirectUri());
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', OAUTH_SCOPE);
  authorizeUrl.searchParams.set('state', state);
  return authorizeUrl.toString();
}

export function FeishuConfigDialog({ config, onSave }: FeishuConfigDialogProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [createResult, setCreateResult] = useState<{
    success: boolean;
    message: string;
    bitableUrl?: string;
  } | null>(null);
  const [formData, setFormData] = useState<FeishuConfig>({
    appId: '',
    appSecret: '',
    appToken: '',
    tableId: '',
    authMode: 'tenant',
  });

  const redirectUri = useMemo(() => buildRedirectUri(), []);

  const persistConfig = (nextConfig: FeishuConfig) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextConfig));
    } catch {
      // ignore
    }
    onSave(nextConfig);
  };

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;

      const parsed = JSON.parse(saved) as FeishuConfig;
      const normalized: FeishuConfig = {
        authMode: 'tenant',
        ...parsed,
      };
      setFormData(normalized);
      onSave(normalized);
    } catch {
      // ignore
    }
  }, [onSave]);

  const applyCreateResponse = (data: CreateResponse) => {
    const nextConfig: FeishuConfig = {
      ...formData,
      authMode: data.authMode || 'tenant',
      appToken: data.appToken || '',
      tableId: data.tableId || '',
      userAccessToken: data.userAccessToken,
      userRefreshToken: data.userRefreshToken,
      userTokenExpiresAt: data.userTokenExpiresAt,
      userOpenId: data.userOpenId,
      userName: data.userName,
      userGrantedScope: data.userGrantedScope,
    };

    setFormData(nextConfig);
    persistConfig(nextConfig);

    const fieldList = (data.fields || []).map((field) => field.name).join('、');
    const baseMessage = `已创建多维表格，含 ${data.fields?.length || 0} 个字段：${fieldList}`;
    setCreateResult({
      success: true,
      message: data.warning ? `${baseMessage} ${data.warning}` : baseMessage,
      bitableUrl: data.bitableUrl,
    });
  };

  const createWithTenantMode = async () => {
    if (!formData.appId || !formData.appSecret) {
      setCreateResult({ success: false, message: '请先填写 App ID 和 App Secret。' });
      return;
    }

    setCreating(true);
    setCreateResult(null);

    try {
      const response = await fetch('/api/feishu/create-bitable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: formData.appId,
          appSecret: formData.appSecret,
          authMode: 'tenant',
        }),
      });

      const data = (await response.json()) as CreateResponse;
      if (!response.ok || data.error) {
        setCreateResult({ success: false, message: data.error || '创建失败。' });
        return;
      }

      applyCreateResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建失败。';
      setCreateResult({ success: false, message });
    } finally {
      setCreating(false);
    }
  };

  const consumeOAuthResult = async (payload: OAuthResultPayload) => {
    const expectedState =
      typeof window === 'undefined' ? '' : localStorage.getItem(OAUTH_STATE_KEY) || '';

    if (!payload.state || payload.state !== expectedState) {
      try {
        localStorage.removeItem(OAUTH_RESULT_KEY);
      } catch {
        // ignore
      }
      setAuthorizing(false);
      setCreateResult({
        success: false,
        message: '飞书授权状态已失效，请重新点击“授权并创建多维表格”。',
      });
      return;
    }

    try {
      localStorage.removeItem(OAUTH_RESULT_KEY);
      localStorage.removeItem(OAUTH_STATE_KEY);
    } catch {
      // ignore
    }

    if (payload.error) {
      setAuthorizing(false);
      setCreateResult({
        success: false,
        message: payload.errorDescription || payload.error || '飞书授权失败。',
      });
      return;
    }

    if (!payload.code) {
      setAuthorizing(false);
      setCreateResult({
        success: false,
        message: '飞书没有返回授权码，请重新授权。',
      });
      return;
    }

    setAuthorizing(true);
    setCreateResult({
      success: true,
      message: '授权已完成，正在创建多维表格，请稍候…',
    });

    try {
      const response = await fetch('/api/feishu/create-bitable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: formData.appId,
          appSecret: formData.appSecret,
          authMode: 'user',
          code: payload.code,
          redirectUri: buildRedirectUri(),
        }),
      });

      const data = (await response.json()) as CreateResponse;
      if (!response.ok || data.error) {
        setCreateResult({ success: false, message: data.error || '授权后创建失败。' });
        return;
      }

      applyCreateResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : '授权后创建失败。';
      setCreateResult({ success: false, message });
    } finally {
      setAuthorizing(false);
    }
  };

  useEffect(() => {
    const consumeOAuthFromCurrentUrl = () => {
      if (window.opener) return;

      const currentUrl = new URL(window.location.href);
      if (currentUrl.searchParams.get('feishu_oauth') !== '1') return;

      const payload: OAuthResultPayload = {
        type: 'feishu-oauth-result',
        code: currentUrl.searchParams.get('code') || '',
        state: currentUrl.searchParams.get('state') || '',
        error: currentUrl.searchParams.get('error') || '',
        errorDescription: currentUrl.searchParams.get('error_description') || '',
      };

      if (payload.code || payload.error) {
        void consumeOAuthResult(payload);
      }
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const payload = event.data as OAuthResultPayload;
      if (payload?.type !== 'feishu-oauth-result') return;
      void consumeOAuthResult(payload);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== OAUTH_RESULT_KEY || !event.newValue) return;

      try {
        const payload = JSON.parse(event.newValue) as OAuthResultPayload;
        if (payload?.type === 'feishu-oauth-result') {
          void consumeOAuthResult(payload);
        }
      } catch {
        // ignore
      }
    };

    window.addEventListener('message', handleMessage);
    window.addEventListener('storage', handleStorage);
    consumeOAuthFromCurrentUrl();

    if (window.opener) {
      return () => {
        window.removeEventListener('message', handleMessage);
        window.removeEventListener('storage', handleStorage);
      };
    }

    const existingResult = localStorage.getItem(OAUTH_RESULT_KEY);
    if (existingResult) {
      try {
        const payload = JSON.parse(existingResult) as OAuthResultPayload;
        if (payload?.type === 'feishu-oauth-result') {
          void consumeOAuthResult(payload);
        }
      } catch {
        // ignore
      }
    }

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('storage', handleStorage);
    };
  }, [formData.appId, formData.appSecret]);

  const handleSave = () => {
    persistConfig(formData);
    setOpen(false);
  };

  const updateField = (field: keyof FeishuConfig, value: string) => {
    setFormData((prev) => {
      if (field === 'appId' || field === 'appSecret') {
        return {
          ...prev,
          [field]: value,
          authMode: 'tenant',
          appToken: '',
          tableId: '',
          userAccessToken: '',
          userRefreshToken: '',
          userTokenExpiresAt: undefined,
          userOpenId: '',
          userName: '',
        };
      }

      return { ...prev, [field]: value };
    });
    setCreateResult(null);
  };

  const handleAuthorizeAndCreate = () => {
    if (!formData.appId || !formData.appSecret) {
      setCreateResult({ success: false, message: '请先填写 App ID 和 App Secret。' });
      return;
    }

    const state = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const authorizeUrl = buildAuthorizeUrl(formData.appId, state);

    try {
      localStorage.removeItem(OAUTH_RESULT_KEY);
      localStorage.setItem(OAUTH_STATE_KEY, state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(formData));
    } catch {
      // ignore
    }

    setAuthorizing(true);
    setCreateResult({
      success: true,
      message: '已拉起飞书授权，完成授权后窗口会自动关闭并回填结果。',
    });

    const popup = window.open(authorizeUrl, 'feishu-oauth', 'width=540,height=760');
    if (!popup) {
      window.location.href = authorizeUrl;
      return;
    }

    popup.focus();
  };

  const isConfigured = Boolean(
    config?.appId && config?.appSecret && config?.appToken && config?.tableId
  );
  const isUserAuthorized = Boolean(
    formData.authMode === 'user' && formData.userRefreshToken
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`gap-2 ${
            isConfigured
              ? 'border-emerald-500/30 text-emerald-400'
              : 'border-slate-600 text-slate-400'
          }`}
        >
          <Settings className="h-3.5 w-3.5" />
          飞书配置
          {isConfigured && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
        </Button>
      </DialogTrigger>

      <DialogContent className="border-slate-700 bg-[#1a1d27] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-slate-200">飞书多维表格配置</DialogTitle>
          <DialogDescription className="text-slate-500">
            推荐使用飞书用户授权创建，谁授权谁就能直接访问，不会再落到“向应用申请权限”。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-200">
            <p>请先在飞书开放平台的应用安全设置里配置重定向地址：</p>
            <p className="mt-1 break-all text-blue-300">
              {redirectUri || '当前页面加载后会自动生成回调地址'}
            </p>
            <p className="mt-2 text-blue-300">
              注意：这是 OAuth 重定向地址，不是事件订阅地址。
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="appId" className="text-xs text-slate-400">
              App ID <span className="text-red-400">*</span>
            </Label>
            <Input
              id="appId"
              value={formData.appId}
              onChange={(event) => updateField('appId', event.target.value)}
              placeholder="cli_xxxxxxxxxxxx"
              className="border-slate-600 bg-slate-900 text-sm text-slate-200 placeholder:text-slate-600"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="appSecret" className="text-xs text-slate-400">
              App Secret <span className="text-red-400">*</span>
            </Label>
            <Input
              id="appSecret"
              type="password"
              value={formData.appSecret}
              onChange={(event) => updateField('appSecret', event.target.value)}
              placeholder="应用密钥"
              className="border-slate-600 bg-slate-900 text-sm text-slate-200 placeholder:text-slate-600"
            />
          </div>

          <div className="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-xs text-slate-300">
            <div className="flex items-center gap-2">
              <ShieldCheck
                className={`h-3.5 w-3.5 ${
                  isUserAuthorized ? 'text-emerald-400' : 'text-slate-500'
                }`}
              />
              <span>
                用户授权状态：
                {isUserAuthorized
                  ? `已授权${formData.userName ? `（${formData.userName}）` : ''}`
                  : '未授权'}
              </span>
            </div>
          </div>

          <Button
            type="button"
            onClick={handleAuthorizeAndCreate}
            disabled={authorizing || creating || !formData.appId || !formData.appSecret}
            className="w-full gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {authorizing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {authorizing ? '正在等待飞书授权…' : '授权并创建多维表格（推荐）'}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={createWithTenantMode}
            disabled={creating || authorizing || !formData.appId || !formData.appSecret}
            className="w-full gap-2 border-blue-500/30 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
          >
            {creating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            {creating ? '正在创建多维表格…' : '仍使用应用身份创建（可能需申请访问）'}
          </Button>

          {createResult && (
            <div
              className={`rounded-lg border p-3 text-xs ${
                createResult.success
                  ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'
                  : 'border-red-500/20 bg-red-500/5 text-red-300'
              }`}
            >
              <div className="flex items-start gap-2">
                {createResult.success ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <div className="min-w-0">
                  <p>{createResult.message}</p>
                  {createResult.bitableUrl && (
                    <a
                      href={createResult.bitableUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                    >
                      打开多维表格 <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="border-t border-slate-700 pt-4">
            <p className="mb-3 text-xs text-slate-500">
              也可以手动填写已有的多维表格信息；授权并创建后这里会自动回填。
            </p>

            <div className="space-y-2">
              <Label htmlFor="appToken" className="text-xs text-slate-400">
                多维表格 App Token
              </Label>
              <Input
                id="appToken"
                value={formData.appToken}
                onChange={(event) => updateField('appToken', event.target.value)}
                placeholder="多维表格 URL 中 /base/ 后面的字符串"
                className="border-slate-600 bg-slate-900 text-sm text-slate-200 placeholder:text-slate-600"
              />
            </div>

            <div className="mt-3 space-y-2">
              <Label htmlFor="tableId" className="text-xs text-slate-400">
                数据表 Table ID
              </Label>
              <Input
                id="tableId"
                value={formData.tableId}
                onChange={(event) => updateField('tableId', event.target.value)}
                placeholder="tblXXXXXXXXXXXXXX"
                className="border-slate-600 bg-slate-900 text-sm text-slate-200 placeholder:text-slate-600"
              />
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            className="text-slate-400"
          >
            <X className="mr-1 h-3.5 w-3.5" />
            取消
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
          >
            <Save className="mr-1 h-3.5 w-3.5" />
            保存配置
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
