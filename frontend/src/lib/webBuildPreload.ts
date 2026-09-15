export function supportsWebBuildRefresh(location: { protocol: string; hostname: string }, native: boolean): boolean {
  return /^https?:$/.test(location.protocol)
    && (!native || !['localhost', '127.0.0.1', ''].includes(location.hostname));
}

/** 只准备当前站点的 Next 静态资源，不执行抓到的脚本，也不访问接口或外域。 */
export function webBuildAssetUrls(values: string[], origin: string): string[] {
  const urls = new Set<string>();
  for (const value of values) {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash
      || !url.pathname.startsWith('/_next/static/')
      || !/\.(?:js|css|woff2?)$/.test(url.pathname)) continue;
    urls.add(url.href);
  }
  if (!urls.size || urls.size > 100) throw new Error('页面资源清单不可用');
  return [...urls];
}

export function documentHasPendingInput(doc: Document): boolean {
  const candidates = doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLElement>(
    'input:not([type="hidden"]):not([type="button"]):not([type="submit"]), textarea, [contenteditable="true"], [data-web-update-block="true"]',
  );
  for (const element of candidates) {
    if (!element.getClientRects().length) continue;
    if (element.dataset.webUpdateBlock === 'true') return true;
    if ('disabled' in element && element.disabled) continue;
    if (element.isContentEditable) {
      if (element.textContent?.trim() || doc.activeElement === element) return true;
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.readOnly) continue;
      if (element instanceof HTMLInputElement && ['checkbox', 'radio'].includes(element.type)) {
        if (element.checked !== element.defaultChecked) return true;
      } else if (element.value.trim() || doc.activeElement === element) return true;
    }
  }
  return false;
}

export async function preloadWebBuildResources(signal: AbortSignal, progress: (completed: number, total: number) => void,
  expected: { buildId: string; pathname: string }): Promise<void> {
  const signalWithTimeout = () => AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  // 不携带查询中的资料 ID、邀请参数等，只取当前路由公开页面壳。
  const origin = window.location.origin;
  const pageUrl = new URL(expected.pathname, origin);
  if (pageUrl.origin !== origin || pageUrl.pathname !== expected.pathname || pageUrl.search || pageUrl.hash) throw new Error('页面地址已变化');
  const response = await fetch(pageUrl, {
    cache: 'no-store', credentials: 'omit', redirect: 'error', headers: { Accept: 'text/html' }, signal: signalWithTimeout(),
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('页面暂不可用');
  const html = await response.text();
  if (html.length > 4_000_000) throw new Error('页面资源清单过大');
  const document = new DOMParser().parseFromString(html, 'text/html');
  const markers = document.querySelectorAll('meta[name="zhicui-web-build"]');
  if (markers.length !== 1 || markers[0].getAttribute('content') !== expected.buildId) throw new Error('页面版本与更新清单不一致');
  const elements = document.querySelectorAll('script[src], link[rel="stylesheet"][href], link[rel="preload"][href]');
  const urls = webBuildAssetUrls([...elements].map(element => element.getAttribute('src') || element.getAttribute('href') || ''), origin);
  let index = 0;
  let completed = 0;
  progress(completed, urls.length);
  const abort = new AbortController();
  try {
    await Promise.all(Array.from({ length: Math.min(3, urls.length) }, async () => {
      while (index < urls.length) {
        const url = urls[index++];
        const asset = await fetch(url, { cache: 'force-cache', credentials: 'omit', redirect: 'error',
          signal: AbortSignal.any([signal, abort.signal, AbortSignal.timeout(20_000)]) });
        if (!asset.ok || asset.headers.get('content-type')?.includes('text/html')) throw new Error('页面资源未完整下载');
        // EOF 后才计入已完成数量；没有按时间伪造百分比。
        await asset.arrayBuffer();
        if (signal.aborted || abort.signal.aborted) throw new Error('已取消资源准备');
        progress(++completed, urls.length);
      }
    }));
  } catch (error) { abort.abort(); throw error; }
}
