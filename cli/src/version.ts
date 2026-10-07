import { createRequire } from 'node:module';

/** 发行包为唯一版本来源，避免升级后仍向 Agent 报告旧版。 */
export const CLI_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
