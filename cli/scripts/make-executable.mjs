import { chmod } from 'node:fs/promises';
import { resolve } from 'node:path';

await chmod(resolve('dist', 'index.js'), 0o755);
