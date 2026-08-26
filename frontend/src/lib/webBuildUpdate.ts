import { CURRENT_WEB_BUILD } from '../generated/buildVersion';
import {
  isDifferentWebBuild,
  parseWebBuildManifest,
  type WebBuildManifest,
} from './webBuildManifest';
export {
  isDifferentWebBuild,
  parseWebBuildManifest,
  type WebBuildManifest,
} from './webBuildManifest';
const PRODUCTION_MARKER_URL = 'https://luxai.cn/build-version.json';

export function currentWebBuild(): WebBuildManifest {
  return parseWebBuildManifest(CURRENT_WEB_BUILD);
}

export async function fetchLatestWebBuild(
  signal?: AbortSignal,
): Promise<WebBuildManifest> {
  const endpoint = process.env.NODE_ENV === 'development'
    ? '/build-version.json'
    : PRODUCTION_MARKER_URL;
  const separator = endpoint.includes('?') ? '&' : '?';
  const response = await fetch(`${endpoint}${separator}t=${Date.now()}`, {
    cache: 'no-store',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error(`网页版本检查失败（${response.status}）`);
  return parseWebBuildManifest(await response.json());
}
