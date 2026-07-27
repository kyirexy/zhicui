'use client';

import { Smartphone, Globe, Cpu } from 'lucide-react';
import AppUpdateSettingsCard from '@/components/AppUpdateSettingsCard';

export default function SettingsPage() {
  return (
    <div className="max-w-2xl mx-auto pb-24">
      <div className="mb-6 md:mb-8">
        <h1 className="text-xl md:text-3xl font-bold text-foreground text-balance">设置</h1>
        <p className="text-foreground-muted text-sm mt-1 text-pretty">应用信息、版本更新与连接状态</p>
      </div>

      <div className="space-y-4">
        <div className="p-5 rounded-2xl bg-card-bg border border-card-border">
          <div className="flex items-center gap-3 mb-4">
            <span className="text-2xl">🫒</span>
            <div>
              <p className="text-base font-semibold text-foreground">知萃 KnowBrew</p>
              <p className="text-xs text-foreground-muted mt-0.5">知萃 v1.1.0</p>
            </div>
          </div>
          <p className="text-sm text-foreground-secondary leading-relaxed">
            将短视频一键转化为结构化知识卡片。支持食谱提取、知识洞察、历史解读、好物推荐和计划管理。
          </p>
        </div>

        <AppUpdateSettingsCard />

        <div className="p-5 rounded-2xl bg-card-bg border border-card-border space-y-4">
          <div className="flex items-center gap-3">
            <Smartphone size={18} className="text-accent-emerald flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-foreground">连接方式</p>
              <p className="text-xs text-foreground-muted mt-0.5">
                正式版通过 HTTPS 安全连接 luxai.cn，登录状态保存在当前设备
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Globe size={18} className="text-foreground-muted flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-foreground">Web 版</p>
              <p className="text-xs text-foreground-muted mt-0.5">
                网页端与 Android 端共用账号、视频资料库、知识卡和计划
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Cpu size={18} className="text-foreground-muted flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-foreground">AI 引擎</p>
              <p className="text-xs text-foreground-muted mt-0.5">
                使用管理端当前启用的模型配置，切换模型后无需重新安装 App
              </p>
            </div>
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-card-bg border border-card-border">
          <p className="text-xs text-foreground-muted leading-relaxed text-center">
            Android App 会在启动时自动检查新版；也可以随时在本页查看更新日志。
          </p>
        </div>
      </div>
    </div>
  );
}
