'use client';

import { useEffect } from 'react';
import { beginWebBuildActivity } from '../webBuildActivity';

/** 同步、AI 对话等前台任务在完成前阻止自动刷新；卸载自动释放所属任务。 */
export function useWebBuildActivity(scope: string, busy: boolean): void {
  useEffect(() => busy ? beginWebBuildActivity(scope) : undefined, [scope, busy]);
}
