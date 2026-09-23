/** 无音频是确定的处理结果，不能凭网络错误或 404 推断。 */
export function isNoAudioResult(item: {
  state?: string;
  transcript_status?: string;
  transcript_source?: string;
  error_code?: string;
  transcript_chars?: number;
  transcript_ready?: boolean;
}): boolean {
  if (item.transcript_ready || (item.transcript_chars || 0) > 0) return false;
  return item.state === 'no_audio' || item.transcript_status === 'no_audio'
    || item.transcript_source === 'no-audio' || item.error_code === 'no_audio';
}

/** 卡片和详情只显示面向用户的提示，不泄露下载地址、堆栈或供应商原始响应。 */
export function libraryExtractionErrorMessage(error?: string): string {
  const message = error || '';
  if (/账号连接未能读取|重新同步播放地址/.test(message)) return '未取得有效播放地址，请在桌面端重新同步后重试';
  if (/404|not found|410|资源.*(?:失效|不存在)/i.test(message)) return '资源暂不可用，请稍后重试';
  if (/401|403|登录|授权|权限/.test(message)) return '暂时无法读取，请检查账号连接后重试';
  if (/429|限流|频繁|rate.?limit/i.test(message)) return '处理请求较多，请稍后重试';
  if (/余额|额度|配额/.test(message)) return '提取额度暂不可用，请稍后重试';
  if (/timeout|timed out|超时|network|connection|网络/i.test(message)) return '连接暂时中断，请稍后重试';
  return '暂时未能提取，请稍后重试';
}
