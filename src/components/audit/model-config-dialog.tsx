'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, CheckCircle2, ExternalLink, Save, Settings, X } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ModelApiConfig, ModelProvider } from '@/lib/types';

interface ModelConfigDialogProps {
  config: ModelApiConfig | null;
  onSave: (config: ModelApiConfig) => void;
}

const STORAGE_KEY = 'audit_model_config';
const DEFAULT_ARK_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

function createDefaultConfig(): ModelApiConfig {
  return {
    provider: 'ark',
    apiKey: '',
    endpointId: '',
    modelName: '',
    baseUrl: DEFAULT_ARK_BASE_URL,
    modelBaseUrl: DEFAULT_ARK_BASE_URL,
  };
}

function normalizeModelConfig(config: ModelApiConfig): ModelApiConfig {
  const provider = config.provider || 'ark';
  const defaultBaseUrl = provider === 'ark' ? DEFAULT_ARK_BASE_URL : DEFAULT_OPENAI_BASE_URL;
  const modelBaseUrl = (config.modelBaseUrl || config.baseUrl || defaultBaseUrl).trim();

  return {
    provider,
    apiKey: config.apiKey.trim(),
    endpointId: config.endpointId.trim(),
    modelName: config.modelName.trim(),
    baseUrl: modelBaseUrl,
    modelBaseUrl,
  };
}

function isConfigured(config: ModelApiConfig | null): boolean {
  if (!config) return false;
  if (!config.apiKey.trim()) return false;

  if (config.provider === 'ark') {
    return Boolean(config.endpointId.trim());
  }

  return Boolean(config.modelName.trim() && config.modelBaseUrl.trim());
}

export function ModelConfigDialog({ config, onSave }: ModelConfigDialogProps) {
  const [open, setOpen] = useState(false);
  const [formData, setFormData] = useState<ModelApiConfig>(createDefaultConfig);
  const [apiKeyInputKey, setApiKeyInputKey] = useState(0);
  const hasInitializedRef = useRef(false);

  useEffect(() => {
    if (hasInitializedRef.current) return;

    hasInitializedRef.current = true;

    let initialConfig: ModelApiConfig | null = null;

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        initialConfig = normalizeModelConfig(JSON.parse(saved) as ModelApiConfig);
      }
    } catch {
      // ignore
    }

    if (!initialConfig && config) {
      initialConfig = normalizeModelConfig(config);
    }

    if (initialConfig) {
      setFormData(initialConfig);
      if (!config || JSON.stringify(normalizeModelConfig(config)) !== JSON.stringify(initialConfig)) {
        onSave(initialConfig);
      }
    }
  }, [config, onSave]);

  useEffect(() => {
    if (!open || !config) return;

    const normalizedConfig = normalizeModelConfig(config);
    setFormData((current) => {
      const normalizedCurrent = normalizeModelConfig(current);
      return JSON.stringify(normalizedCurrent) === JSON.stringify(normalizedConfig)
        ? current
        : normalizedConfig;
    });
    setApiKeyInputKey((prev) => prev + 1);
  }, [config, open]);

  const providerOptions = useMemo(
    () => [
      { value: 'ark' as ModelProvider, label: '豆包 / 方舟' },
      { value: 'openai-compatible' as ModelProvider, label: 'OpenAI 兼容' },
    ],
    []
  );

  const handleProviderChange = (provider: ModelProvider) => {
    setFormData((prev) => {
      if (provider === 'ark') {
        return normalizeModelConfig({
          ...prev,
          provider,
          baseUrl: prev.provider === 'ark' ? prev.baseUrl : DEFAULT_ARK_BASE_URL,
          modelBaseUrl: prev.provider === 'ark' ? prev.modelBaseUrl : DEFAULT_ARK_BASE_URL,
        });
      }

      return normalizeModelConfig({
        ...prev,
        provider,
        baseUrl: prev.provider === 'openai-compatible' ? prev.baseUrl : DEFAULT_OPENAI_BASE_URL,
        modelBaseUrl:
          prev.provider === 'openai-compatible' ? prev.modelBaseUrl : DEFAULT_OPENAI_BASE_URL,
      });
    });
  };

  const updateField = (field: keyof ModelApiConfig, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  const clearApiKey = () => {
    setFormData((prev) => ({ ...prev, apiKey: '' }));
    setApiKeyInputKey((prev) => prev + 1);
  };

  const handleSave = () => {
    const normalized = normalizeModelConfig(formData);

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // ignore
    }

    setFormData(normalized);
    onSave(normalized);
    setOpen(false);
  };

  const isReady = isConfigured(config);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`gap-2 ${
            isReady ? 'border-emerald-500/30 text-emerald-400' : 'border-slate-600 text-slate-400'
          }`}
        >
          <Settings className="h-3.5 w-3.5" />
          模型配置
          {isReady && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
        </Button>
      </DialogTrigger>

      <DialogContent className="border-slate-700 bg-[#1a1d27] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-slate-200">AI 模型配置</DialogTitle>
          <DialogDescription className="sr-only">
            配置审核模型的 API Key、接入点或 OpenAI 兼容网关信息
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-300">
            <p>保存后将优先使用这里的全局模型连接。</p>
            <p className="mt-1 text-blue-200/80">
              规则里的模型选择仍会保留，但全局配置会优先生效。
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-slate-400">服务商</Label>
            <Select
              value={formData.provider}
              onValueChange={(value) => handleProviderChange(value as ModelProvider)}
            >
              <SelectTrigger className="border-slate-600 bg-slate-900 text-sm text-slate-200">
                <SelectValue placeholder="选择服务商" />
              </SelectTrigger>
              <SelectContent className="border-slate-700 bg-[#1a1d27]">
                {providerOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value} className="text-slate-200">
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="model-api-key" className="text-xs text-slate-400">
              API Key
            </Label>
            <div className="relative">
              <Input
                key={apiKeyInputKey}
                id="model-api-key"
                name={`model-api-key-${formData.provider}`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                value={formData.apiKey}
                onChange={(event) => updateField('apiKey', event.target.value)}
                placeholder={formData.provider === 'ark' ? 'ARK_API_KEY' : '请输入 API Key'}
                className="border-slate-600 bg-slate-900 pr-10 text-sm text-slate-200 placeholder:text-slate-600"
              />
              {formData.apiKey && (
                <button
                  type="button"
                  onClick={clearApiKey}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 transition hover:text-slate-300"
                  aria-label="清空 API Key"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>

          {formData.provider === 'ark' ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="endpoint-id" className="text-xs text-slate-400">
                  Endpoint ID（推理接入点 ID）
                </Label>
                <Input
                  id="endpoint-id"
                  value={formData.endpointId}
                  onChange={(event) => updateField('endpointId', event.target.value)}
                  placeholder="YOUR_ENDPOINT_ID"
                  className="border-slate-600 bg-slate-900 text-sm text-slate-200 placeholder:text-slate-600"
                />
                <p className="text-[10px] text-slate-500">
                  不要填写 API Key 资源 ID，这里要填在线推理页面里的 Endpoint ID。
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="ark-base-url" className="text-xs text-slate-400">
                  Base URL（可选）
                </Label>
                <Input
                  id="ark-base-url"
                  value={formData.modelBaseUrl}
                  onChange={(event) => updateField('modelBaseUrl', event.target.value)}
                  placeholder={DEFAULT_ARK_BASE_URL}
                  className="border-slate-600 bg-slate-900 text-sm text-slate-200 placeholder:text-slate-600"
                />
                <p className="text-[10px] text-slate-500">
                  默认使用火山方舟兼容地址，可按需替换为私有网关。
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="compatible-base-url" className="text-xs text-slate-400">
                  Base URL
                </Label>
                <Input
                  id="compatible-base-url"
                  value={formData.modelBaseUrl}
                  onChange={(event) => updateField('modelBaseUrl', event.target.value)}
                  placeholder={DEFAULT_OPENAI_BASE_URL}
                  className="border-slate-600 bg-slate-900 text-sm text-slate-200 placeholder:text-slate-600"
                />
                <p className="text-[10px] text-slate-500">
                  支持 OpenAI、DeepSeek、OpenRouter、硅基流动等 OpenAI-compatible 网关。
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="model-name" className="text-xs text-slate-400">
                  模型名
                </Label>
                <Input
                  id="model-name"
                  value={formData.modelName}
                  onChange={(event) => updateField('modelName', event.target.value)}
                  placeholder="gpt-4o-mini / deepseek-chat / kimi-k2"
                  className="border-slate-600 bg-slate-900 text-sm text-slate-200 placeholder:text-slate-600"
                />
              </div>
            </>
          )}

          <div className="rounded-lg border border-slate-700/70 bg-slate-900/60 p-3 text-xs text-slate-400">
            <div className="flex items-start gap-2">
              <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
              <div className="space-y-1">
                <p>豆包 / 方舟：填 `API Key + Endpoint ID` 即可。</p>
                <p>非豆包模型：切到 `OpenAI 兼容`，填 `API Key + Base URL + 模型名`。</p>
                <a
                  href="https://platform.openai.com/docs/api-reference/introduction"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                >
                  查看 OpenAI 兼容接口说明 <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>

          {isConfigured(normalizeModelConfig(formData)) && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
              <CheckCircle2 className="h-3.5 w-3.5" />
              当前表单已具备可用配置，保存后即可用于审核。
            </div>
          )}
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
