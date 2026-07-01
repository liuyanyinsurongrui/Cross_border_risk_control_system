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

const PROHIBITED_SCREENING_PROMPT = `你是一名跨境商品禁售类目意图识别助手。请先判断以下商品是否值得进入“禁售商品”审核，而不是直接下最终违规结论。

请重点识别这些高风险意图：
1. 武器、弹药、刀具、攻击器械及其关键配件
2. 烟花爆竹、火药、引火物、爆炸物相关商品
3. 药品、处方药、医疗器械、注射类产品、宣称治疗或药用功效的商品
4. 活体动植物、种子、菌种、土壤、标本、野生动物制品
5. 危险化学品、易燃易爆品、腐蚀性、有毒或放射性物质
6. 监听偷拍设备、破解设备、规避监管或违法用途工具
7. 明显属于海关、物流或当地法规限制运输或销售的禁限售品

请基于以下信息判断是否需要进入“禁售商品”内容审核：
商品名称：{product_name}
页面标题：{page_title}
页面链接：{page_url}
页面文字：
{text_content}

判断原则：
- 如果商品从名称、标题、描述上看，明显或较大概率属于上述禁售、限售或高风险范围，请只输出“命中”。
- 如果只是普通商品，且没有明显指向禁售类目的语义，请只输出“不命中”。
- 如果存在边界情况，但从文字上已经值得进一步复核，也输出“命中”。

只输出“命中”或“不命中”，不要补充解释。`;

const PROHIBITED_AUDIT_PROMPT = `你是一名跨境电商禁售商品审核专家。请严格判断该商品是否属于禁售、限售或高风险商品，并输出标准 JSON 结果。

审核重点：
1. 是否为武器、刀具、枪支弹药、攻击器械或其关键配件
2. 是否为烟花爆竹、火药、引火类、爆炸物相关商品
3. 是否为药品、处方药、医疗器械、注射类、宣称治疗功效的特殊用品
4. 是否为活体植物、活体动物、繁殖材料、种子、菌种、受保护动植物制品
5. 是否为危险化学品、易燃易爆品、腐蚀性、毒性或放射性物质
6. 是否为监听偷拍、破解、规避监管、违法使用工具
7. 是否存在明显违反海关运输、跨境销售或当地法规限制的情形

输出要求：
- 只有在证据明确时判定“违规”。
- 不明确但高度可疑时判定“待人工复核”。
- 普通商品且无相关风险证据时判定“合规”。
- 必须给出具体证据，证据优先引用页面文字、标题、规格、用途描述和图片信息。`;

export const DEFAULT_AUDIT_RULES: AuditRule[] = [
  {
    id: 'rule-false-ad',
    name: '虚假宣传',
    screeningPrompt:
      '请判断以下商品信息是否需要进入“虚假宣传”审核。若商品页面可能涉及夸大功效、虚构认证、绝对化宣传、虚假折扣或其他宣传合规风险，请只输出“命中”；否则只输出“不命中”。\n\n商品名称：{product_name}\n页面标题：{page_title}\n页面文字：\n{text_content}',
    prompt:
      '请审核该商品页面是否存在虚假宣传或误导性营销，包括但不限于：夸大产品功效、伪造检测认证、虚构用户评价或销量、使用绝对化用语、制造虚假限时优惠、虚构原价折扣等。请严格输出标准 JSON 结果，并给出明确证据。',
    enabled: true,
    model: '',
  },
  {
    id: 'rule-ip',
    name: '知识产权侵权',
    screeningPrompt:
      '请判断以下商品信息是否需要进入“知识产权侵权”审核。若商品可能涉及品牌侵权、商标或 Logo 使用不当、外观仿冒、文案盗用、包装混淆等风险，请只输出“命中”；否则只输出“不命中”。\n\n商品名称：{product_name}\n页面标题：{page_title}\n页面文字：\n{text_content}',
    prompt:
      '请审核该商品页面是否存在知识产权侵权风险，包括但不限于：未经授权使用品牌名称、商标、Logo，仿冒知名商品外观，盗用图片文案，或使用易引发消费者混淆的包装与命名。请严格输出标准 JSON 结果，并给出明确证据。',
    enabled: true,
    model: '',
  },
  {
    id: 'rule-prohibited',
    name: '禁售商品',
    screeningPrompt: PROHIBITED_SCREENING_PROMPT,
    prompt: PROHIBITED_AUDIT_PROMPT,
    enabled: true,
    model: '',
  },
  {
    id: 'rule-price-fraud',
    name: '价格欺诈',
    screeningPrompt:
      '请判断以下商品信息是否需要进入“价格欺诈”审核。若商品页面可能涉及价格误导、虚假折扣、隐藏费用、比较价不实等问题，请只输出“命中”；否则只输出“不命中”。\n\n商品名称：{product_name}\n页面标题：{page_title}\n页面文字：\n{text_content}',
    prompt:
      '请审核该商品页面是否存在价格欺诈或价格误导行为，包括但不限于：虚构原价、夸大折扣、隐藏运费税费、标价单位不清、捆绑销售未说明、虚假对比价等。请严格输出标准 JSON 结果，并给出明确证据。',
    enabled: true,
    model: '',
  },
  {
    id: 'rule-misleading-img',
    name: '误导性图片',
    screeningPrompt:
      '请判断以下商品信息是否需要进入“误导性图片”审核。若商品页面可能存在图文不符、效果图误导、附赠品未说明、过度修图等风险，请只输出“命中”；否则只输出“不命中”。\n\n商品名称：{product_name}\n页面标题：{page_title}\n页面文字：\n{text_content}',
    prompt:
      '请审核该商品页面的图片是否存在误导消费者的情况，包括但不限于：商品图与实物严重不符、使用效果图但未说明、图片展示了不包含在售价内的配件或赠品、过度修图掩盖缺陷等。请严格输出标准 JSON 结果，并给出明确证据。',
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
      <DialogContent className="flex max-h-[85vh] max-w-[620px] flex-col overflow-hidden border-[#2a2d3a] bg-[#1a1d27] text-[#e2e8f0]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[#e2e8f0]">
            <Shield className="h-5 w-5 text-[#10b981]" />
            审核规则配置
          </DialogTitle>
          <DialogDescription className="text-[#94a3b8]">
            每条规则支持单独维护“意图识别提示词”和“内容审核提示词”。
            命中意图识别后，系统才会继续执行该规则的内容审核。
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
  const [editScreeningPrompt, setEditScreeningPrompt] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editModel, setEditModel] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScreeningPrompt, setNewScreeningPrompt] = useState('');
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
    setEditScreeningPrompt(rule.screeningPrompt || '');
    setEditPrompt(rule.prompt);
    setEditModel(modelMap.has(rule.model) ? rule.model : firstModelId);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditScreeningPrompt('');
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
              screeningPrompt: editScreeningPrompt.trim() || undefined,
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
      screeningPrompt: newScreeningPrompt.trim() || undefined,
      prompt: newPrompt.trim(),
      enabled: true,
      model: hasModelOptions ? newModel : '',
    };
    onChange({ ...rules, rules: [...rules.rules, newRule] });
    setNewName('');
    setNewScreeningPrompt('');
    setNewPrompt('');
    setNewModel(firstModelId);
    setAddingNew(false);
  };

  const cancelAdd = () => {
    setNewName('');
    setNewScreeningPrompt('');
    setNewPrompt('');
    setNewModel(firstModelId);
    setAddingNew(false);
  };

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
          当前还没有可用模型，请先在右上角完成模型配置。
        </div>
      )}

      {addingNew && (
        <div className="mt-3 space-y-3 rounded-lg border border-[#10b981]/30 bg-[#10b981]/5 p-4">
          <div className="space-y-1.5">
            <label className="text-[11px] text-[#94a3b8]">规则名称</label>
            <Input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="如：禁售商品审核"
              className="h-8 border-[#2a2d3a] bg-[#0f1117] text-xs text-[#e2e8f0] placeholder:text-[#4a5568]"
            />
          </div>
          <PromptField
            label="意图识别提示词"
            value={newScreeningPrompt}
            onChange={setNewScreeningPrompt}
            placeholder="可选。命中后才会继续执行内容审核。支持 {product_name}、{page_title}、{page_url}、{text_content} 占位符。"
            description="留空时默认直接进入内容审核，避免影响已有规则。"
          />
          <PromptField
            label="内容审核提示词"
            value={newPrompt}
            onChange={setNewPrompt}
            placeholder="AI 将严格按照此提示词审核页面内容"
          />
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
                <PromptField
                  label="意图识别提示词"
                  value={editScreeningPrompt}
                  onChange={setEditScreeningPrompt}
                  placeholder="可选。命中后才会继续执行内容审核。"
                  description="支持 {product_name}、{page_title}、{page_url}、{text_content} 占位符。"
                />
                <PromptField
                  label="内容审核提示词"
                  value={editPrompt}
                  onChange={setEditPrompt}
                  placeholder="AI 将严格按照此提示词审核页面内容"
                />
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
                    <PromptPreview
                      title="意图识别提示词"
                      content={rule.screeningPrompt?.trim() || '未配置，当前会默认直接进入内容审核。'}
                    />
                    <PromptPreview title="内容审核提示词" content={rule.prompt} />

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
                      {!rule.model && <span className="text-[11px] text-amber-300">未配置</span>}
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

function PromptField({
  label,
  value,
  onChange,
  placeholder,
  description,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  description?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11px] text-[#94a3b8]">{label}</label>
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-h-[88px] resize-none border-[#2a2d3a] bg-[#0f1117] text-xs text-[#e2e8f0] placeholder:text-[#4a5568]"
      />
      {description ? <p className="text-[10px] text-[#64748b]">{description}</p> : null}
    </div>
  );
}

function PromptPreview({ title, content }: { title: string; content: string }) {
  return (
    <div className="rounded-md border border-[#1e2030] bg-[#0f1117] p-3">
      <p className="mb-1.5 text-[10px] uppercase tracking-wider text-[#4a5568]">{title}</p>
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-[#94a3b8]">{content}</p>
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
