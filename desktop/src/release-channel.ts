import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type PackagedReleaseChannel = 'beta' | 'stable';

export function parsePackagedReleaseChannel(value: unknown): PackagedReleaseChannel {
  return value === 'stable' ? 'stable' : 'beta';
}

export function readPackagedReleaseChannel(appPath: string): PackagedReleaseChannel {
  try {
    const packageJson = JSON.parse(
      readFileSync(join(appPath, 'package.json'), 'utf8'),
    ) as { releaseChannel?: unknown };
    return parsePackagedReleaseChannel(packageJson.releaseChannel);
  } catch {
    // 历史未写渠道的安装包均为未签名内测包，绝不能提升为 stable。
    return 'beta';
  }
}
