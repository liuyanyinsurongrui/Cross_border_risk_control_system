'use client';

import React from 'react';
import { CheckCircle, XCircle, Clock, AlertTriangle, BarChart3 } from 'lucide-react';
import type { AuditResult } from '@/lib/types';

interface StatsBarProps {
  results: AuditResult[];
}

export function StatsBar({ results }: StatsBarProps) {
  const total = results.length;
  const passed = results.filter((result) => result.status === 'passed' && result.conclusion === '合规').length;
  const violated = results.filter(
    (result) => result.status === 'violated' || result.conclusion === '违规'
  ).length;
  const reviewing = results.filter((result) => result.conclusion === '待人工复核').length;
  const unaudited = results.filter(
    (result) => result.status === 'unaudited' || (result.conclusion === '未审核' && result.status !== 'pending')
  ).length;
  const pending = results.filter((result) => result.status === 'pending').length;
  const fetched = results.filter((result) => result.status === 'fetched').length;
  const processing = results.filter(
    (result) => result.status === 'scraping' || result.status === 'auditing'
  ).length;
  const errors = results.filter((result) => result.status === 'error').length;

  const stats = [
    { icon: BarChart3, label: '总计', value: total, color: 'text-slate-300', bg: 'bg-slate-500/10' },
    { icon: Clock, label: '待审核', value: pending, color: 'text-slate-400', bg: 'bg-slate-500/10' },
    { icon: Clock, label: '已抓取', value: fetched, color: 'text-cyan-400', bg: 'bg-cyan-500/10' },
    { icon: Clock, label: '未审核', value: unaudited, color: 'text-slate-500', bg: 'bg-slate-500/10' },
    { icon: CheckCircle, label: '合规', value: passed, color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    { icon: XCircle, label: '违规', value: violated, color: 'text-red-400', bg: 'bg-red-500/10' },
    { icon: AlertTriangle, label: '待复核', value: reviewing, color: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  ].filter((item) => item.value > 0 || item.label === '总计' || item.label === '待审核');

  if (processing > 0) {
    stats.push({
      icon: Clock,
      label: '处理中',
      value: processing,
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
    });
  }

  if (errors > 0) {
    stats.push({
      icon: AlertTriangle,
      label: '错误',
      value: errors,
      color: 'text-red-300',
      bg: 'bg-red-500/5',
    });
  }

  return (
    <div className="flex flex-wrap gap-3">
      {stats.map((stat) => (
        <div key={stat.label} className={`flex items-center gap-2 rounded-lg px-3 py-2 ${stat.bg}`}>
          <stat.icon className={`h-4 w-4 ${stat.color}`} />
          <div>
            <p className="text-lg font-semibold leading-tight text-slate-200">{stat.value}</p>
            <p className={`text-[10px] ${stat.color}`}>{stat.label}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
