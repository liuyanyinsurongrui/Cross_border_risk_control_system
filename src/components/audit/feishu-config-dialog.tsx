'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

interface AuthorizeResponse {
  success?: boolean;
  error?: string;
  authMode?: 'tenant' | 'user';
  appToken?: string;
  tableId?: string;
  bitableUrl?: string;
  userAccessToken?: string;
  userRefreshToken?: string;
  userTokenExpiresAt?: number;
  userOpenId?: string;
  userName?: string;
  userGrantedScope?: string;
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

function normalizeConfig(config?: Partial<FeishuConfig> | null): FeishuConfig {
  return {
    appId: '',
    appSecret: '',
    appToken: '',
    tableId: '',
    authMode: 'tenant',
    ...config,
  };
}

function buildOAuthPayloadKey(payload: OAuthResultPayload) {
  return `${payload.state}::${payload.code || payload.error}`;
}

export function FeishuConfigDialog({ config, onSave }: FeishuConfigDialogProps) {
  const [open, setOpen] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [savingAppConfig, setSavingAppConfig] = useState(false);
  const [resultMessage, setResultMessage] = useState<{
    success: boolean;
    message: string;
    bitableUrl?: string;
  } | null>(null);
  const [formData, setFormData] = useState<FeishuConfig>(normalizeConfig(config));

  const redirectUri = useMemo(() => buildRedirectUri(), []);
  const formDataRef = useRef(formData);
  const processedOAuthKeysRef = useRef<Set<string>>(new Set());
  const processingOAuthKeyRef = useRef<string | null>(null);
  const activeOAuthStateRef = useRef<string>('');

  useEffect(() => {
    formDataRef.current = formData;
  }, [formData]);

  const persistConfig = useCallback(
    (nextConfig: FeishuConfig) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(nextConfig));
      } catch {
        // ignore
      }
      onSave(nextConfig);
    },
    [onSave]
  );

  const clearOAuthStorage = useCallback(() => {
    try {
      localStorage.removeItem(OAUTH_RESULT_KEY);
      localStorage.removeItem(OAUTH_STATE_KEY);
    } catch {
      // ignore
    }
    activeOAuthStateRef.current = '';
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      const parsed = normalizeConfig(JSON.parse(saved) as FeishuConfig);
      setFormData(parsed);
      onSave(parsed);
    } catch {
      // ignore
    }
  }, [onSave]);

  useEffect(() => {
    if (!config) return;
    setFormData((current) => {
      const nextConfig = normalizeConfig(config);
      if (JSON.stringify(current) === JSON.stringify(nextConfig)) {
        return current;
      }
      return nextConfig;
    });
  }, [config]);

  const applyAuthorizeResponse = useCallback(
    (data: AuthorizeResponse) => {
      const currentConfig = formDataRef.current;
      const nextConfig: FeishuConfig = {
        ...currentConfig,
        authMode: data.authMode || currentConfig.authMode || 'tenant',
        appToken: data.appToken ?? currentConfig.appToken ?? '',
        tableId: data.tableId ?? currentConfig.tableId ?? '',
        bitableUrl: data.bitableUrl ?? currentConfig.bitableUrl,
        userAccessToken: data.userAccessToken,
        userRefreshToken: data.userRefreshToken,
        userTokenExpiresAt: data.userTokenExpiresAt,
        userOpenId: data.userOpenId,
        userName: data.userName,
        userGrantedScope: data.userGrantedScope,
      };

      setFormData(nextConfig);
      persistConfig(nextConfig);

      setResultMessage({
        success: true,
        message:
          nextConfig.authMode === 'user'
            ? '飞书用户授权已保存。业务创建好多维表格后，直接填写 App Token 和 Table ID 即可使用。'
            : '应用配置已保存。',
        bitableUrl: nextConfig.bitableUrl,
      });
    },
    [persistConfig]
  );

  const saveAppConfigOnly = useCallback(async () => {
    const currentConfig = formDataRef.current;
    if (!currentConfig.appId || !currentConfig.appSecret) {
      setResultMessage({ success: false, message: '请先填写 App ID 和 App Secret。' });
      return;
    }

    setSavingAppConfig(true);
    setResultMessage(null);

    try {
      const response = await fetch('/api/feishu/create-bitable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appId: currentConfig.appId,
          appSecret: currentConfig.appSecret,
          authMode: 'tenant',
          appToken: currentConfig.appToken,
          tableId: currentConfig.tableId,
          bitableUrl: currentConfig.bitableUrl,
        }),
      });

      const data = (await response.json()) as AuthorizeResponse;
      if (!response.ok || data.error) {
        setResultMessage({ success: false, message: data.error || '保存配置失败。' });
        return;
      }

      applyAuthorizeResponse(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存配置失败。';
      setResultMessage({ success: false, message });
    } finally {
      setSavingAppConfig(false);
    }
  }, [applyAuthorizeResponse]);

  const consumeOAuthResult = useCallback(
    async (payload: OAuthResultPayload) => {
      const payloadKey = buildOAuthPayloadKey(payload);
      if (!payload.state || (!payload.code && !payload.error)) return;

      if (
        processedOAuthKeysRef.current.has(payloadKey) ||
        processingOAuthKeyRef.current === payloadKey
      ) {
        return;
      }

      const expectedState =
        activeOAuthStateRef.current ||
        (typeof window === 'undefined' ? '' : localStorage.getItem(OAUTH_STATE_KEY) || '');

      if (!expectedState || payload.state !== expectedState) return;

      processingOAuthKeyRef.current = payloadKey;
      clearOAuthStorage();

      if (payload.error) {
        processedOAuthKeysRef.current.add(payloadKey);
        processingOAuthKeyRef.current = null;
        setAuthorizing(false);
        setResultMessage({
          success: false,
          message: payload.errorDescription || payload.error || '飞书授权失败。',
        });
        return;
      }

      if (!payload.code) {
        processedOAuthKeysRef.current.add(payloadKey);
        processingOAuthKeyRef.current = null;
        setAuthorizing(false);
        setResultMessage({
          success: false,
          message: '飞书没有返回授权码，请重新授权。',
        });
        return;
      }

      setAuthorizing(true);
      setResultMessage({
        success: true,
        message: '授权已完成，正在保存飞书授权信息，请稍候…',
      });

      try {
        const currentConfig = formDataRef.current;
        const response = await fetch('/api/feishu/create-bitable', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            appId: currentConfig.appId,
            appSecret: currentConfig.appSecret,
            authMode: 'user',
            code: payload.code,
            redirectUri: buildRedirectUri(),
            appToken: currentConfig.appToken,
            tableId: currentConfig.tableId,
            bitableUrl: currentConfig.bitableUrl,
          }),
        });

        const data = (await response.json()) as AuthorizeResponse;
        if (!response.ok || data.error) {
          setResultMessage({
            success: false,
            message: data.error || '授权成功，但保存授权信息失败，请重新授权。',
          });
          return;
        }

        applyAuthorizeResponse(data);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : '授权后保存飞书授权信息失败，请重试。';
        setResultMessage({ success: false, message });
      } finally {
        processedOAuthKeysRef.current.add(payloadKey);
        processingOAuthKeyRef.current = null;
        setAuthorizing(false);
      }
    },
    [applyAuthorizeResponse, clearOAuthStorage]
  );

  useEffect(() => {
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
  }, [consumeOAuthResult]);

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
          userAccessToken: '',
          userRefreshToken: '',
          userTokenExpiresAt: undefined,
          userOpenId: '',
          userName: '',
          userGrantedScope: '',
        };
      }

      return { ...prev, [field]: value };
    });
    setResultMessage(null);
  };

  const handleAuthorize = () => {
    const currentConfig = formDataRef.current;
    if (!currentConfig.appId || !currentConfig.appSecret) {
      setResultMessage({ success: false, message: '请先填写 App ID 和 App Secret。' });
      return;
    }

    const state = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const authorizeUrl = buildAuthorizeUrl(currentConfig.appId, state);

    processedOAuthKeysRef.current.clear();
    processingOAuthKeyRef.current = null;
    activeOAuthStateRef.current = state;

    try {
      localStorage.removeItem(OAUTH_RESULT_KEY);
      localStorage.setItem(OAUTH_STATE_KEY, state);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(currentConfig));
    } catch {
      // ignore
    }

    setAuthorizing(true);
    setResultMessage({
      success: true,
      message: '已拉起飞书授权，完成后会自动保存授权信息。',
    });

    const popup = window.open(authorizeUrl, 'feishu-oauth', 'width=540,height=760');
    if (!popup) {
      window.location.href = authorizeUrl;
      return;
    }

    popup.focus();
  };

  const isConfigured = Boolean(
    formData.appId && formData.appSecret && formData.appToken && formData.tableId
  );
  const isUserAuthorized = Boolean(formData.authMode === 'user' && formData.userRefreshToken);

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
            推荐先完成飞书用户授权。业务侧创建好多维表格后，再填写已有的 App Token 和
            Table ID。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-200">
            <p>请先在飞书开放平台的应用安全设置里配置重定向地址：</p>
            <p className="mt-1 break-all text-blue-300">
              {redirectUri || '当前页面加载后会自动生成回调地址'}
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
            onClick={handleAuthorize}
            disabled={authorizing || savingAppConfig || !formData.appId || !formData.appSecret}
            className="w-full gap-2 bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {authorizing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {authorizing ? '正在等待飞书授权…' : '仅授权飞书用户（推荐）'}
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={saveAppConfigOnly}
            disabled={savingAppConfig || authorizing || !formData.appId || !formData.appSecret}
            className="w-full gap-2 border-blue-500/30 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
          >
            {savingAppConfig ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" />
            )}
            {savingAppConfig ? '正在保存配置…' : '仅保存应用配置'}
          </Button>

          {resultMessage && (
            <div
              className={`rounded-lg border p-3 text-xs ${
                resultMessage.success
                  ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-300'
                  : 'border-red-500/20 bg-red-500/5 text-red-300'
              }`}
            >
              <div className="flex items-start gap-2">
                {resultMessage.success ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                ) : (
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                )}
                <div className="min-w-0">
                  <p>{resultMessage.message}</p>
                  {resultMessage.bitableUrl && (
                    <a
                      href={resultMessage.bitableUrl}
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
              这里请填写业务侧已经创建好的多维表格信息；授权仅用于后续直接访问和写入。
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
