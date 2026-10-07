import { createRequire } from 'node:module';

/** npm 的 dist/ 与桌面 resources/cli 两种布局均读取自己的发行包。 */
function packagedVersion(): string {
  const require = createRequire(import.meta.url);
  for (const path of ['./package.json', '../package.json']) {
    try {
      const value = require(path) as { name?: string; version?: string };
      if (value.name === '@zhicui/cli' && typeof value.version === 'string') return value.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('知萃 CLI 安装包不完整，请重新安装官网 CLI 包');
}
export const CLI_VERSION = packagedVersion();
