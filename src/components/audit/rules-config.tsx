'use client';

import { useMemo, useState } from 'react';
import {
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Cpu,
  Shield,
  Settings2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import type { AuditRules, AuditRule, ModelOption } from '@/lib/types';

export const DEFAULT_AUDIT_RULES: AuditRule[] = [
  {
    id: 'rule-false-ad',
    name: '虚假宣传',
    prompt:
      '检查产品页面是否存在虚假宣传，包括但不限于：夸大产品功效、伪造检测认证、虚构用户评价/销量数据、使用绝对化用语（如"最好""第一""100%有效"）、虚假限时优惠（如倒计时永远不会结束的促销）、虚构原价制造折扣假象。',
    enabled: true,
    model: '',
  },
  {
    id: 'rule-ip',
    name: '知识产权侵权',
    prompt:
      '检查产品页面是否存在知识产权侵权风险，包括但不限于：未经授权使用知名品牌商标/Logo/名称、山寨仿冒知名产品外观设计、盗用他人图片或文案、使用相似包装/品牌名混淆消费者。',
    enabled: true,
    model: '',
  },
  {
    id: 'rule-prohibited',
    name: '违禁品',
    prompt:
      '检查产品是否属于跨境销售违禁品类，包括但不限于：危险武器及配件、违禁药品及医疗器械、受保护动植物制品、危险化学品、侵权盗版商品、各国法规明确禁止跨境销售的品类。',
    enabled: true,
    model: '',
  },
  {
    id: 'rule-price-fraud',
    name: '价格欺诈',
    prompt:
      '检查产品页面是否存在价格欺诈行为，包括但不限于：虚构原价制造大额折扣假象、隐藏附加费用（运费/税费/订阅费未明示）、价格误导（标价单位不清、捆绑销售未说明）、虚假比较价格（与其他平台价格对比不实）。',
    enabled: true,
    model: '',
  },
  {
    id: 'rule-misleading-img',
    name: '误导性图片',
    prompt:
      '检查产品图片是否存在误导消费者的情况，包括但不限于：产品图片与实际商品严重不符（颜色/尺寸/材质差异大）、使用效果图但未标注"仅供参考"、图片中包含未包含在售价内的配件/赠品、过度PS美化掩盖产品缺陷。',
    enabled: true,
    model: '',
  },
];

interface RulesConfigProps {
  rules: AuditRules;
  modelOptions: ModelOption[];
  onChange: (rules: AuditRules) => void;
}

export function RulesConfig({ rules, modelOptions, onChange }: RulesConfigProps) {
  const [open, setOpen] = useState(false);
  const enabledCount = rules.rules.filter((rule) => rule.enabled).length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Card className="cursor-pointer border-border/50 bg-[#1a1d27] transition-colors hover:border-[#2a2d3a]">
          <CardContent className="p-3">
            <div className="flex items-center gap-3">
              <div className="rounded-md bg-[#10b981]/10 p-1.5">
                <Shield className="h-4 w-4 text-[#10b981]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-[#e2e8f0]">审核规则</p>
                <p className="text-[11px] text-[#64748b]">
                  已启用 {enabledCount}/{rules.rules.length} 条规则
                </p>
              </div>
              <Settings2 className="h-4 w-4 text-[#64748b]" />
            </div>
          </CardContent>
        </Card>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] max-w-[560px] flex-col overflow-hidden border-[#2a2d3a] bg-[#1a1d27] text-[#e2e8f0]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#e2e8f0]">
            <Shield className="h-5 w-5 text-[#10b981]" />
            审核规则配置
          </DialogTitle>
          <DialogDescription className="text-[#94a3b8]">
            每条规则的提示词是 AI 审核的核心指令，规则名称仅用于展示。模型选项跟随顶部模型配置自动变化。
          </DialogDescription>
        </DialogHeader>
        <RulesEditor
          rules={rules}
          modelOptions={modelOptions}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function RulesEditor({
  rules,
  modelOptions,
  onChange,
  onClose,
}: {
  rules: AuditRules;
  modelOptions: ModelOption[];
  onChange: (rules: AuditRules) => void;
  onClose: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editModel, setEditModel] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newModel, setNewModel] = useState(modelOptions[0]?.id ?? '');

  const enabledCount = rules.rules.filter((rule) => rule.enabled).length;
  const modelMap = useMemo(
    () => new Map(modelOptions.map((option) => [option.id, option])),
    [modelOptions]
  );
  const firstModelId = modelOptions[0]?.id ?? '';
  const hasModelOptions = modelOptions.length > 0;

  const handleToggle = (id: string) => {
    onChange({
      ...rules,
      rules: rules.rules.map((rule) =>
        rule.id === id ? { ...rule, enabled: !rule.enabled } : rule
      ),
    });
  };

  const handleDelete = (id: string) => {
    onChange({
      ...rules,
      rules: rules.rules.filter((rule) => rule.id !== id),
    });
    if (expandedId === id) setExpandedId(null);
    if (editingId === id) setEditingId(null);
  };

  const handleModelChange = (id: string, model: string) => {
    onChange({
      ...rules,
      rules: rules.rules.map((rule) => (rule.id === id ? { ...rule, model } : rule)),
    });
  };

  const startEdit = (rule: AuditRule) => {
    setEditingId(rule.id);
    setEditName(rule.name);
    setEditPrompt(rule.prompt);
    setEditModel(modelMap.has(rule.model) ? rule.model : firstModelId);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditPrompt('');
    setEditModel('');
  };

  const saveEdit = () => {
    if (!editName.trim() || !editPrompt.trim()) return;
    onChange({
      ...rules,
      rules: rules.rules.map((rule) =>
        rule.id === editingId
          ? {
              ...rule,
              name: editName.trim(),
              prompt: editPrompt.trim(),
              model: hasModelOptions ? editModel : '',
            }
          : rule
      ),
    });
    setEditingId(null);
  };

  const addRule = () => {
    if (!newName.trim() || !newPrompt.trim()) return;
    const newRule: AuditRule = {
      id: `rule-custom-${Date.now()}`,
      name: newName.trim(),
      prompt: newPrompt.trim(),
      enabled: true,
      model: hasModelOptions ? newModel : '',
    };
    onChange({ ...rules, rules: [...rules.rules, newRule] });
    setNewName('');
    setNewPrompt('');
    setNewModel(firstModelId);
    setAddingNew(false);
  };

  const cancelAdd = () => {
    setNewName('');
    setNewPrompt('');
    setNewModel(firstModelId);
    setAddingNew(false);
  };

  const getModelLabel = (modelId: string) => modelMap.get(modelId)?.name || modelId || '未配置';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-[#2a2d3a] pb-3">
        <span className="text-xs text-[#94a3b8]">
          已启用 {enabledCount}/{rules.rules.length} 条规则
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-3 text-xs text-[#10b981] hover:bg-[#10b981]/10 hover:text-[#10b981]"
          onClick={() => {
            setNewModel(firstModelId);
            setAddingNew(true);
          }}
          disabled={addingNew}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          添加规则
        </Button>
      </div>

      {!hasModelOptions && (
        <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
          当前未配置可用模型，请先在右上角完成模型配置，规则模型将保持为空。
        </div>
      )}

      {addingNew && (
        <div className="mt-3 space-y-3 rounded-lg border border-[#10b981]/30 bg-[#10b981]/5 p-4">
          <div className="space-y-1.5">
            <label className="text-[11px] text-[#94a3b8]">规则名称</label>
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="如：虚假宣传检测"
              className="h-8 border-[#2a2d3a] bg-[#0f1117] text-xs text-[#e2e8f0] placeholder:text-[#4a5568]"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-[#94a3b8]">审核提示词</label>
            <Textarea
              value={newPrompt}
              onChange={(event) => setNewPrompt(event.target.value)}
              placeholder="AI 将严格按照此提示词审核产品内容"
              className="min-h-[80px] resize-none border-[#2a2d3a] bg-[#0f1117] text-xs text-[#e2e8f0] placeholder:text-[#4a5568]"
            />
          </div>
          <ModelSelector
            model={newModel}
            options={modelOptions}
            onModelChange={setNewModel}
            disabled={!hasModelOptions}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-3 text-xs text-[#94a3b8]"
              onClick={cancelAdd}
            >
              取消
            </Button>
            <Button
              size="sm"
              className="h-7 px-4 text-xs text-white"
              onClick={addRule}
              disabled={!newName.trim() || !newPrompt.trim()}
            >
              确认添加
            </Button>
          </div>
        </div>
      )}

      <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {rules.rules.map((rule) => (
          <div
            key={rule.id}
            className={`rounded-lg border transition-colors ${
              rule.enabled
                ? 'border-[#2a2d3a] bg-[#1a1d27]'
                : 'border-[#1e2030] bg-[#14161e] opacity-60'
            }`}
          >
            {editingId === rule.id ? (
              <div className="space-y-3 p-4">
                <div className="space-y-1.5">
                  <label className="text-[11px] text-[#94a3b8]">规则名称</label>
                  <Input
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    className="h-8 border-[#2a2d3a] bg-[#0f1117] text-xs text-[#e2e8f0]"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11px] text-[#94a3b8]">审核提示词</label>
                  <Textarea
                    value={editPrompt}
                    onChange={(event) => setEditPrompt(event.target.value)}
                    className="min-h-[80px] resize-none border-[#2a2d3a] bg-[#0f1117] text-xs text-[#e2e8f0]"
                  />
                </div>
                <ModelSelector
                  model={editModel}
                  options={modelOptions}
                  onModelChange={setEditModel}
                  disabled={!hasModelOptions}
                />
                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-3 text-xs text-[#94a3b8]"
                    onClick={cancelEdit}
                  >
                    <X className="mr-1 h-3.5 w-3.5" />
                    取消
                  </Button>
                  <Button
                    size="sm"
                    className="h-7 px-4 text-xs text-white"
                    onClick={saveEdit}
                    disabled={!editName.trim() || !editPrompt.trim()}
                  >
                    <Check className="mr-1 h-3.5 w-3.5" />
                    保存
                  </Button>
                </div>
              </div>
            ) : (
              <div className="p-3">
                <div className="flex items-center gap-2.5">
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={() => handleToggle(rule.id)}
                    className="scale-90 data-[state=checked]:bg-[#10b981] data-[state=unchecked]:bg-[#2a2d3a]"
                  />
                  <span
                    className={`flex-1 text-sm ${
                      rule.enabled ? 'text-[#e2e8f0]' : 'text-[#64748b]'
                    }`}
                  >
                    {rule.name}
                  </span>
                  <span className="flex items-center gap-1 whitespace-nowrap rounded bg-[#2a2d3a] px-1.5 py-0.5 text-[10px] text-[#94a3b8]">
                    <Cpu className="h-2.5 w-2.5" />
                    {getModelShortLabel(rule.model, modelMap)}
                  </span>
                  <button
                    onClick={() => setExpandedId(expandedId === rule.id ? null : rule.id)}
                    className="rounded p-1 text-[#64748b] transition-colors hover:bg-[#2a2d3a] hover:text-[#94a3b8]"
                  >
                    {expandedId === rule.id ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </button>
                </div>

                {expandedId === rule.id && (
                  <div className="mt-3 space-y-3">
                    <div className="rounded-md border border-[#1e2030] bg-[#0f1117] p-3">
                      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-[#4a5568]">
                        提示词（AI 审核指令）
                      </p>
                      <p className="whitespace-pre-wrap text-xs leading-relaxed text-[#94a3b8]">
                        {rule.prompt}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <Cpu className="h-3.5 w-3.5 text-[#64748b]" />
                      <span className="text-[11px] text-[#64748b]">审核模型</span>
                      <Select
                        value={rule.model}
                        onValueChange={(value) => handleModelChange(rule.id, value)}
                        disabled={!hasModelOptions}
                      >
                        <SelectTrigger className="h-7 min-w-[180px] w-auto border-[#2a2d3a] bg-[#0f1117] text-xs text-[#94a3b8]">
                          <SelectValue placeholder="请先配置模型" />
                        </SelectTrigger>
                        <SelectContent className="max-h-[240px] border-[#2a2d3a] bg-[#1a1d27]">
                          {modelOptions.map((option) => (
                            <SelectItem
                              key={option.id}
                              value={option.id}
                              className="text-xs text-[#e2e8f0] focus:bg-[#2a2d3a] focus:text-[#e2e8f0]"
                            >
                              {option.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!rule.model && (
                        <span className="text-[11px] text-amber-300">未配置</span>
                      )}
                    </div>

                    <div className="flex gap-2 pt-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-3 text-xs text-[#94a3b8] hover:text-[#3b82f6]"
                        onClick={() => startEdit(rule)}
                      >
                        <Pencil className="mr-1.5 h-3.5 w-3.5" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-3 text-xs text-[#94a3b8] hover:text-[#ef4444]"
                        onClick={() => {
                          if (confirm(`确定删除规则「${rule.name}」吗？`)) {
                            handleDelete(rule.id);
                          }
                        }}
                      >
                        <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                        删除
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto h-7 px-3 text-xs text-[#94a3b8]"
                        onClick={onClose}
                      >
                        完成
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelSelector({
  model,
  options,
  onModelChange,
  disabled,
}: {
  model: string;
  options: ModelOption[];
  onModelChange: (model: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <label className="flex items-center gap-1.5 text-[11px] text-[#94a3b8]">
        <Cpu className="h-3 w-3" />
        审核模型
      </label>
      <Select value={model} onValueChange={onModelChange} disabled={disabled}>
        <SelectTrigger className="h-8 border-[#2a2d3a] bg-[#0f1117] text-xs text-[#e2e8f0]">
          <SelectValue placeholder="请先配置模型" />
        </SelectTrigger>
        <SelectContent className="max-h-[240px] border-[#2a2d3a] bg-[#1a1d27]">
          {options.map((option) => (
            <SelectItem
              key={option.id}
              value={option.id}
              className="text-xs text-[#e2e8f0] focus:bg-[#2a2d3a] focus:text-[#e2e8f0]"
            >
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function getModelShortLabel(modelId: string, modelMap: Map<string, ModelOption>): string {
  if (!modelId) return '未配置';
  return modelMap.get(modelId)?.name || modelId;
}
