import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT_CODES } from './errors.js';
import { redactedProcessMessage, runProcess } from './process-utils.js';
import { LEGACY_CLI_RELEASES } from './legacy-releases.js';

export type AgentClientName = 'codex' | 'claude';
export type AgentClientSelection = AgentClientName | 'all';

interface KnownTool {
  name: AgentClientName;
  command: string;
  prefixArgs: string[];
  configPath: string;
  skillPath: string;
  timeoutMs: number;
}

interface ConfigSnapshot {
  target: string;
  existed: boolean;
  backup?: string;
}

interface ConfigProvenance {
  schema_version: 1;
  client: AgentClientName;
  config_path: string;
  before_existed: boolean;
  before_sha256?: string;
  backup_path?: string;
  managed_sha256: string;
}

interface ClientProbe {
  installed: boolean;
  version?: string;
  configured: boolean;
  managed: boolean;
  current?: boolean;
  migration_available?: boolean;
  skill_installed: boolean;
  skill_current: boolean;
  error?: string;
}

const MANAGED_MARKER = '<!-- managed-by: @zhicui/cli -->';
const SERVER_NAME = 'zhicui';
const CONFIG_PROVENANCE_VERSION = 1;

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/gu, '-');
}

function envCommand(name: AgentClientName): string | undefined {
  return process.env[`ZHICUI_${name.toUpperCase()}_COMMAND`];
}

function envPrefixArgs(name: AgentClientName): string[] {
  const value = process.env[`ZHICUI_${name.toUpperCase()}_COMMAND_ARGS`];
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    // Invalid overrides are rejected below.
  }
  throw new CliError('USAGE_ERROR', `${name} 命令前缀配置无效`, {
    exitCode: EXIT_CODES.usage,
  });
}

// Codex 桌面内置 CLI 不一定加入 Windows 注册 PATH。只检查官方的一层哈希目录，
// 不把 .codex 配置目录当成安装证据，也不跟随 junction / 符号链接到其他位置。
export async function findWindowsCodexCommand(
  localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
): Promise<string | null> {
  if (!isAbsolute(localAppData) || localAppData.startsWith('\\\\')) return null;
  try {
    let directory = await realpath(localAppData);
    for (const segment of ['OpenAI', 'Codex', 'bin']) {
      directory = join(directory, segment);
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()
        || pathIdentity(await realpath(directory)) !== pathIdentity(directory)) return null;
    }
    const candidates: Array<{ command: string; modified: number }> = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{16,64}$/iu.test(entry.name)) continue;
      try {
        const versionDirectory = join(directory, entry.name);
        const versionMetadata = await lstat(versionDirectory);
        if (versionMetadata.isSymbolicLink()
          || pathIdentity(await realpath(versionDirectory)) !== pathIdentity(versionDirectory)) continue;
        const command = join(versionDirectory, 'codex.exe');
        const metadata = await lstat(command);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0
          || pathIdentity(await realpath(command)) !== pathIdentity(command)) continue;
        candidates.push({ command, modified: metadata.mtimeMs });
      } catch {
        // 更新留下的空目录、未完成安装或已清理的版本均不是可执行安装。
      }
    }
    // 目录名是内容哈希，不是 SemVer；按可执行文件更新时间选择最新完整安装。
    candidates.sort((left, right) => right.modified - left.modified
      || (left.command < right.command ? -1 : left.command > right.command ? 1 : 0));
    return candidates[0]?.command || null;
  } catch { return null; }
}

async function resolveCommand(name: AgentClientName): Promise<string | null> {
  if (envCommand(name)) return envCommand(name)!;
  const lookup = process.platform === 'win32'
    ? await runProcess('where.exe', [name], { allowFailure: true })
      .catch(() => ({ code: 1, stdout: '', stderr: '' }))
    : await runProcess('/usr/bin/env', ['which', name], { allowFailure: true });
  const candidates = lookup.code === 0
    ? lookup.stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)
    : [];
  if (process.platform !== 'win32') return candidates[0] || null;

  // npm creates three Windows shims: an extensionless POSIX shell script,
  // a .cmd launcher, and a .ps1 launcher. `where.exe` commonly lists the
  // extensionless file first, but Node cannot execute that shell script with
  // shell:false on Windows. Select only formats we can launch explicitly and
  // prefer native/application shims before falling back to PowerShell.
  const launchableExtensions = ['.exe', '.com', '.cmd', '.bat', '.ps1'];
  for (const extension of launchableExtensions) {
    const candidate = candidates.find((item) => item.toLowerCase().endsWith(extension));
    if (candidate) return candidate;
  }
  return name === 'codex' ? findWindowsCodexCommand() : null;
}

function configPath(name: AgentClientName): string {
  const override = process.env[`ZHICUI_${name.toUpperCase()}_CONFIG`];
  if (override) return override;
  if (name === 'codex') {
    return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  }
  return join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json');
}

function skillPath(name: AgentClientName): string {
  const override = process.env[`ZHICUI_${name.toUpperCase()}_SKILLS_DIR`];
  const root = override || (name === 'codex'
    ? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills')
    : join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills'));
  return join(root, 'zhicui', 'SKILL.md');
}

async function knownTool(name: AgentClientName, timeoutMs: number): Promise<KnownTool | null> {
  const command = await resolveCommand(name);
  if (!command) return null;
  return {
    name,
    command,
    prefixArgs: envPrefixArgs(name),
    configPath: configPath(name),
    skillPath: skillPath(name),
    timeoutMs,
  };
}

async function runTool(
  tool: KnownTool,
  args: string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const fullArgs = [...tool.prefixArgs, ...args];
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/iu.test(tool.command)) {
    const script = [
      '$payload=[Console]::In.ReadToEnd() | ConvertFrom-Json;',
      '$argv=@($payload.args | ForEach-Object { [string]$_ });',
      '& ([string]$payload.command) @argv;',
      'exit $LASTEXITCODE;',
    ].join('');
    return runProcess('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], {
      input: JSON.stringify({ command: tool.command, args: fullArgs }),
      allowFailure: options.allowFailure,
      timeoutMs: options.timeoutMs ?? tool.timeoutMs,
    });
  }
  return runProcess(tool.command, fullArgs, {
    ...options,
    timeoutMs: options.timeoutMs ?? tool.timeoutMs,
  });
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function snapshotConfig(target: string): Promise<ConfigSnapshot> {
  if (!(await exists(target))) return { target, existed: false };
  const backup = `${target}.zhicui-backup-${timestamp()}`;
  await copyFile(target, backup);
  return { target, existed: true, backup };
}

async function restoreConfig(snapshot: ConfigSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await rm(snapshot.target, { force: true });
    return;
  }
  if (!snapshot.backup) return;
  const temporary = `${snapshot.target}.zhicui-restore-${process.pid}`;
  await copyFile(snapshot.backup, temporary);
  if (process.platform === 'win32') await rm(snapshot.target, { force: true });
  await rename(temporary, snapshot.target);
}

function configProvenancePath(target: string): string {
  return `${target}.zhicui-provenance.json`;
}

function pathIdentity(path: string): string {
  const value = resolve(path).replace(/\\/gu, '/');
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function fileSha256(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

function ownedBackupPath(target: string, backup: string): boolean {
  return pathIdentity(dirname(backup)) === pathIdentity(dirname(target))
    && basename(backup).startsWith(`${basename(target)}.zhicui-backup-`);
}

async function writeConfigProvenance(
  tool: KnownTool,
  snapshot: ConfigSnapshot,
  replace = false,
): Promise<void> {
  const path = configProvenancePath(tool.configPath);
  if (!replace && await exists(path)) {
    throw new CliError(
      'AGENT_CONFIG_CONFLICT',
      `${tool.name} 存在未完成的知萃配置记录，未覆盖`,
      { exitCode: EXIT_CODES.permission },
    );
  }
  const managedSha256 = await fileSha256(tool.configPath);
  if (!managedSha256) {
    throw new CliError('AGENT_SETUP_FAILED', `${tool.name} 配置无法建立完整性记录`);
  }
  const beforeSha256 = snapshot.backup ? await fileSha256(snapshot.backup) : null;
  if (snapshot.existed && (!snapshot.backup || !beforeSha256)) {
    throw new CliError('AGENT_SETUP_FAILED', `${tool.name} 原配置备份无法校验`);
  }
  const provenance: ConfigProvenance = {
    schema_version: CONFIG_PROVENANCE_VERSION,
    client: tool.name,
    config_path: resolve(tool.configPath),
    before_existed: snapshot.existed,
    before_sha256: beforeSha256 || undefined,
    backup_path: snapshot.backup,
    managed_sha256: managedSha256,
  };
  await atomicWrite(path, `${JSON.stringify(provenance, null, 2)}\n`);
}

async function readConfigProvenance(tool: KnownTool): Promise<ConfigProvenance | null> {
  try {
    const parsed = JSON.parse(
      await readFile(configProvenancePath(tool.configPath), 'utf8'),
    ) as Partial<ConfigProvenance>;
    if (
      parsed.schema_version !== CONFIG_PROVENANCE_VERSION
      || parsed.client !== tool.name
      || typeof parsed.config_path !== 'string'
      || pathIdentity(parsed.config_path) !== pathIdentity(tool.configPath)
      || typeof parsed.before_existed !== 'boolean'
      || typeof parsed.managed_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(parsed.managed_sha256)
    ) return null;
    if (!parsed.before_existed) {
      if (parsed.backup_path !== undefined || parsed.before_sha256 !== undefined) return null;
      return parsed as ConfigProvenance;
    }
    if (
      typeof parsed.backup_path !== 'string'
      || typeof parsed.before_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(parsed.before_sha256)
      || !ownedBackupPath(tool.configPath, parsed.backup_path)
      || await fileSha256(parsed.backup_path) !== parsed.before_sha256
    ) return null;
    return parsed as ConfigProvenance;
  } catch {
    return null;
  }
}

function provenanceSnapshot(tool: KnownTool, value: ConfigProvenance): ConfigSnapshot {
  return {
    target: tool.configPath,
    existed: value.before_existed,
    backup: value.backup_path,
  };
}

async function removeConfigProvenance(tool: KnownTool, value: ConfigProvenance): Promise<void> {
  if (value.backup_path && ownedBackupPath(tool.configPath, value.backup_path)) {
    await rm(value.backup_path, { force: true });
  }
  // Remove the pointer last. If backup cleanup fails, the still-present and
  // hash-validated provenance keeps the operation recoverable on a retry.
  await rm(configProvenancePath(tool.configPath), { force: true });
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

async function restoreTextFile(path: string, previous: string | null): Promise<void> {
  if (previous === null) {
    await rm(path, { force: true });
    await rm(dirname(path), { recursive: false }).catch(() => undefined);
    return;
  }
  await atomicWrite(path, previous);
}

function packageRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const adjacentSkills = join(moduleDirectory, 'skills', 'zhicui', 'SKILL.md');
  // npm executes from `<package>/dist`, while Electron flattens the compiled
  // files to `resources/cli` and places Skills beside them.  Prefer the
  // adjacent packaged resource when present, then fall back to the npm root.
  return existsSync(adjacentSkills) ? moduleDirectory : resolve(moduleDirectory, '..');
}

async function managedSkillSource(): Promise<string> {
  const path = join(packageRoot(), 'skills', 'zhicui', 'SKILL.md');
  const content = await readFile(path, 'utf8');
  if (!content.includes(MANAGED_MARKER)) {
    throw new CliError('LOCAL_CAPABILITY_UNAVAILABLE', 'CLI 包内的知萃 Skill 缺少所有权标记', {
      exitCode: EXIT_CODES.localUnavailable,
    });
  }
  return content;
}

async function installSkill(path: string): Promise<{ changed: boolean; backup?: string }> {
  const source = await managedSkillSource();
  if (await exists(path)) {
    const current = await readFile(path, 'utf8');
    if (current === source) return { changed: false };
    if (!current.includes(MANAGED_MARKER)) {
      throw new CliError('SKILL_CONFLICT', `已有非知萃管理的 Skill：${basename(dirname(path))}`, {
        exitCode: EXIT_CODES.permission,
      });
    }
    const backup = `${path}.zhicui-backup-${timestamp()}`;
    await copyFile(path, backup);
    await atomicWrite(path, source);
    return { changed: true, backup };
  }
  await atomicWrite(path, source);
  return { changed: true };
}

async function uninstallSkill(path: string): Promise<boolean> {
  if (!(await exists(path))) return false;
  const current = await readFile(path, 'utf8');
  if (!current.includes(MANAGED_MARKER)) return false;
  // 用户可在受管 Skill 上增补内容；卸载也须先保留原文。
  if (current !== await managedSkillSource()) {
    await copyFile(path, `${path}.zhicui-backup-${timestamp()}`);
  }
  await rm(path, { force: true });
  await rm(dirname(path), { recursive: false }).catch(() => undefined);
  return true;
}

function selfMcpCommand(): { command: string; args: string[]; env: string[] } {
  if (process.env.ZHICUI_CLI_EXECUTABLE) {
    return { command: process.env.ZHICUI_CLI_EXECUTABLE, args: [], env: [] };
  }
  const entry = resolve(dirname(fileURLToPath(import.meta.url)), 'index.js');
  const electron = Boolean(process.versions.electron);
  return {
    command: process.execPath,
    args: [entry],
    env: electron ? ['ELECTRON_RUN_AS_NODE=1'] : [],
  };
}

function normalizeProbeValue(value: string): string {
  const normalized = value.trim().replace(/\\/gu, '/').replace(/\s+/gu, ' ');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function normalizedEnvironment(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeProbeValue)
      .sort();
  }
  if (typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, item]) => normalizeProbeValue(`${key}=${item}`))
    .sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface StdioSpec { command: string; args: string[]; env: Record<string, string> }

function stdioSpec(value: unknown, codex: boolean): StdioSpec | null {
  if (!isRecord(value)) return null;
  let item = value;
  if (codex && isRecord(value.transport)) {
    const allowed = new Set(['name', 'enabled', 'disabled_reason', 'transport', 'startup_timeout_sec',
      'tool_timeout_sec', 'enabled_tools', 'disabled_tools']);
    if ((value.name != null && value.name !== SERVER_NAME) || Object.keys(value).some((key) => !allowed.has(key)) || value.enabled === false
      || value.disabled_reason || value.startup_timeout_sec != null || value.tool_timeout_sec != null
      || value.enabled_tools != null || value.disabled_tools != null) return null;
    item = value.transport;
  }
  const allowed = new Set(['type', 'command', 'args', 'env', ...(codex ? ['env_vars', 'cwd'] : [])]);
  if (Object.keys(item).some((key) => !allowed.has(key))) return null;
  if (item.type !== undefined && item.type !== 'stdio') return null;
  if (typeof item.command !== 'string' || !Array.isArray(item.args)
    || !item.args.every((arg) => typeof arg === 'string')) return null;
  if (item.cwd != null || (item.env_vars != null
    && (!Array.isArray(item.env_vars) || item.env_vars.length !== 0))) return null;
  if (item.env != null && (!isRecord(item.env)
    || Object.values(item.env).some((entry) => typeof entry !== 'string'))) return null;
  return { command: item.command, args: item.args as string[], env: (item.env || {}) as Record<string, string> };
}

function matchesSelf(spec: StdioSpec): boolean {
  const expected = selfMcpCommand();
  return spec.args.slice(-3).join(' ') === 'mcp serve --stdio'
    && normalizeProbeValue(spec.command) === normalizeProbeValue(expected.command)
    && JSON.stringify(spec.args.map(normalizeProbeValue))
      === JSON.stringify([...expected.args, 'mcp', 'serve', '--stdio'].map(normalizeProbeValue))
    && JSON.stringify(normalizedEnvironment(spec.env))
      === JSON.stringify(expected.env.map(normalizeProbeValue).sort());
}

async function legacyPackageMatches(spec: StdioSpec): Promise<boolean> {
  if (spec.args.length !== 4 || spec.args.slice(1).join(' ') !== 'mcp serve --stdio') return false;
  if (!['node', 'node.exe'].includes(basename(spec.command).toLowerCase())
    || Object.keys(spec.env).length !== 0) return false;
  const entry = spec.args[0];
  if (basename(entry) !== 'index.js' || basename(dirname(entry)) !== 'dist') return false;
  const root = resolve(dirname(entry), '..');
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== '@zhicui/cli' || pkg.type !== 'module' || pkg.bin?.zhicui !== 'dist/index.js') return false;
    for (const release of LEGACY_CLI_RELEASES.filter((candidate) => candidate.version === pkg.version)) {
      let match = true;
      for (const [path, hash] of Object.entries(release.files)) {
        if (path.startsWith('skills/')) continue; // Skill 可独立更新，执行文件必须全部一致。
        if (await fileSha256(join(root, path)) !== hash) { match = false; break; }
      }
      if (match) return true;
    }
  } catch { /* 旧目录不存在或无法完整校验，不猜测所有权。 */ }
  return false;
}

async function managedProbe(tool: KnownTool, stdout: string): Promise<{ managed: boolean; current: boolean }> {
  try {
    const raw = tool.name === 'codex' ? JSON.parse(stdout)
      : JSON.parse(await readFile(tool.configPath, 'utf8')).mcpServers?.[SERVER_NAME];
    const spec = stdioSpec(raw, tool.name === 'codex');
    if (!spec) return { managed: false, current: false };
    if (matchesSelf(spec)) return { managed: true, current: true };
    // 只有完整原配置记录，或已验收发行包的全部执行文件指纹，可以证明旧注册归属。
    const provenance = await readConfigProvenance(tool);
    const recorded = Boolean(provenance && await fileSha256(tool.configPath) === provenance.managed_sha256);
    const canonical = spec.args.slice(-3).join(' ') === 'mcp serve --stdio'
      && spec.args.length <= 4 && Object.entries(spec.env).every(([key, value]) => key === 'ELECTRON_RUN_AS_NODE' && value === '1');
    return { managed: canonical && (recorded || await legacyPackageMatches(spec)), current: false };
  } catch { return { managed: false, current: false }; }
}

async function rawProbe(tool: KnownTool): Promise<ClientProbe> {
  const version = await runTool(tool, ['--version'], { allowFailure: true });
  if (version.code !== 0) {
    return {
      installed: false,
      configured: false,
      managed: false,
      skill_installed: false,
      skill_current: false,
    };
  }
  const getArgs = tool.name === 'codex'
    ? ['mcp', 'get', SERVER_NAME, '--json']
    : ['mcp', 'get', SERVER_NAME];
  const configured = await runTool(tool, getArgs, { allowFailure: true });
  const isConfigured = configured.code === 0;
  const ownership = isConfigured ? await managedProbe(tool, configured.stdout) : { managed: false, current: false };
  const installedSkill = await exists(tool.skillPath)
    ? await readFile(tool.skillPath, 'utf8')
    : null;
  const skillInstalled = Boolean(installedSkill?.includes(MANAGED_MARKER));
  const skillCurrent = skillInstalled && installedSkill === await managedSkillSource();
  return {
    installed: true,
    version: version.stdout.trim() || version.stderr.trim(),
    configured: isConfigured,
    managed: ownership.managed,
    current: ownership.current,
    migration_available: ownership.managed && !ownership.current,
    skill_installed: skillInstalled,
    skill_current: skillCurrent,
  };
}

async function addMcp(tool: KnownTool): Promise<void> {
  const self = selfMcpCommand();
  if (tool.name === 'codex') {
    const envArgs = self.env.flatMap((value) => ['--env', value]);
    await runTool(tool, [
      'mcp', 'add', SERVER_NAME, ...envArgs, '--',
      self.command, ...self.args, 'mcp', 'serve', '--stdio',
    ]);
    return;
  }
  const envArgs = self.env.flatMap((value) => ['-e', value]);
  await runTool(tool, [
    'mcp', 'add', '-s', 'user', SERVER_NAME, ...envArgs, '--',
    self.command, ...self.args, 'mcp', 'serve', '--stdio',
  ]);
}

async function removeMcp(tool: KnownTool): Promise<void> {
  const args = tool.name === 'claude'
    ? ['mcp', 'remove', '-s', 'user', SERVER_NAME]
    : ['mcp', 'remove', SERVER_NAME];
  await runTool(tool, args, { allowFailure: true });
}

export class AgentClientManager {
  constructor(private readonly timeoutMs = 30_000) {}

  async mcpHealth(profile: string, apiUrl: string): Promise<{ ok: boolean; tool_count: number; code: string }> {
    const self = selfMcpCommand();
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map((value) => JSON.stringify(value)).join('\n') + '\n';
    try {
      const result = await runProcess(self.command, [...self.args, 'mcp', 'serve', '--stdio', '--profile', profile], {
        input, timeoutMs: this.timeoutMs, allowFailure: true,
        env: { ...process.env, ZHICUI_API_URL: apiUrl, ...Object.fromEntries(self.env.map((value) => value.split('='))) },
      });
      const messages = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
      const initialized = messages.find((item) => item.id === 1)?.result?.serverInfo?.name === '@zhicui/cli';
      const tools = messages.find((item) => item.id === 2)?.result?.tools;
      const count = Array.isArray(tools) ? tools.filter((tool) => typeof tool.name === 'string'
        && tool.name.startsWith('zhicui_') && !['zhicui_run_get', 'zhicui_run_events', 'zhicui_run_cancel'].includes(tool.name)).length : 0;
      const ok = result.code === 0 && initialized && count > 0;
      return { ok, tool_count: count, code: ok ? 'READY' : 'MCP_UNAVAILABLE' };
    } catch { return { ok: false, tool_count: 0, code: 'MCP_UNAVAILABLE' }; }
  }

  async status(selection: AgentClientSelection): Promise<Record<string, ClientProbe>> {
    const result: Record<string, ClientProbe> = {};
    for (const name of this.names(selection)) {
      try {
        const tool = await knownTool(name, this.timeoutMs);
        result[name] = tool
          ? await rawProbe(tool)
          : {
            installed: false,
            configured: false,
            managed: false,
            skill_installed: false,
            skill_current: false,
          };
      } catch (error) {
        result[name] = {
          installed: false,
          configured: false,
          managed: false,
          skill_installed: false,
          skill_current: false,
          error: redactedProcessMessage(error instanceof Error ? error.message : String(error)),
        };
      }
    }
    return result;
  }

  async setup(selection: AgentClientSelection): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const name of this.names(selection)) {
      const tool = await knownTool(name, this.timeoutMs);
      if (!tool) {
        result[name] = { installed: false, changed: false, error: `${name} 未安装` };
        continue;
      }
      const before = await rawProbe(tool);
      if (before.managed && before.current && before.skill_current) {
        result[name] = { ...before, changed: false };
        continue;
      }
      if (before.configured && !before.managed) {
        throw new CliError(
          'AGENT_CONFIG_CONFLICT',
          `${name} 已存在同名但非知萃管理的 MCP 配置，未做覆盖`,
          { exitCode: EXIT_CODES.permission },
        );
      }
      const migrating = before.configured && before.managed && !before.current;
      const snapshot = !before.configured || migrating ? await snapshotConfig(tool.configPath) : null;
      const previousProvenance = await readFile(configProvenancePath(tool.configPath), 'utf8').catch(() => null);
      const previousSkill = await exists(tool.skillPath)
        ? await readFile(tool.skillPath, 'utf8')
        : null;
      if (previousSkill !== null && !previousSkill.includes(MANAGED_MARKER)) {
        throw new CliError('SKILL_CONFLICT', `${name} 已有自定义知萃 Skill，已保留原文`, { exitCode: EXIT_CODES.permission });
      }
      let provenanceCreated = false;
      try {
        let baseline = snapshot;
        if (migrating) {
          await removeMcp(tool);
          if ((await rawProbe(tool)).configured) throw new CliError('AGENT_SETUP_FAILED', '旧注册未移除');
          baseline = await snapshotConfig(tool.configPath);
        }
        if (!before.configured || migrating) await addMcp(tool);
        const skill = await installSkill(tool.skillPath);
        const after = await rawProbe(tool);
        if (!after.configured || !after.managed || !after.current || !after.skill_current) {
          throw new CliError('AGENT_SETUP_FAILED', `${name} 配置校验失败`);
        }
        if (baseline) {
          await writeConfigProvenance(tool, baseline, migrating);
          provenanceCreated = true;
        }
        result[name] = {
          ...after,
          changed: true,
          skill_changed: skill.changed,
          migrated: migrating,
          skill_backup: skill.backup || null,
          backup_created: Boolean(snapshot?.backup || skill.backup),
        };
      } catch (error) {
        if (provenanceCreated) {
          await restoreTextFile(configProvenancePath(tool.configPath), previousProvenance).catch(() => undefined);
        }
        if (snapshot) await restoreConfig(snapshot).catch(() => undefined);
        await restoreTextFile(tool.skillPath, previousSkill).catch(() => undefined);
        throw new CliError('AGENT_SETUP_FAILED', `${name} 接入失败，已恢复配置`, {
          cause: error,
        });
      }
    }
    return result;
  }

  async update(selection: AgentClientSelection): Promise<Record<string, unknown>> {
    return this.setup(selection);
  }

  async reconcile(selection: AgentClientSelection): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    const status = await this.status(selection);
    for (const name of this.names(selection)) {
      const probe = status[name];
      if (!probe.installed || !probe.configured) {
        result[name] = { ...probe, changed: false, skipped: true, code: 'NOT_CONFIGURED' };
      } else if (!probe.managed) {
        result[name] = { ...probe, changed: false, code: 'AGENT_CONFIG_CONFLICT' };
      } else {
        try { Object.assign(result, await this.setup(name)); }
        catch (error) { result[name] = { ...probe, changed: false, code: error instanceof CliError ? error.code : 'AGENT_SETUP_FAILED' }; }
      }
    }
    return result;
  }

  async uninstall(selection: AgentClientSelection): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const name of this.names(selection)) {
      const tool = await knownTool(name, this.timeoutMs);
      if (!tool) {
        result[name] = { installed: false, changed: false };
        continue;
      }
      const before = await rawProbe(tool);
      const snapshot = await snapshotConfig(tool.configPath);
      const provenance = await readConfigProvenance(tool);
      const restoreOriginal = Boolean(
        provenance
        && before.configured
        && before.managed
        && await fileSha256(tool.configPath) === provenance.managed_sha256,
      );
      const previousSkill = await exists(tool.skillPath)
        ? await readFile(tool.skillPath, 'utf8')
        : null;
      try {
        if (before.configured && before.managed) await removeMcp(tool);
        if (restoreOriginal && provenance) {
          await restoreConfig(provenanceSnapshot(tool, provenance));
        }
        const skillRemoved = await uninstallSkill(tool.skillPath);
        const after = await rawProbe(tool);
        if (before.managed && after.configured) {
          throw new CliError('AGENT_UNINSTALL_FAILED', `${name} MCP 配置仍然存在`);
        }
        if (provenance) await removeConfigProvenance(tool, provenance);
        result[name] = {
          ...after,
          changed: (before.configured && before.managed) || skillRemoved,
          backup_created: Boolean(snapshot.backup),
          config_restored: restoreOriginal,
        };
      } catch (error) {
        await restoreConfig(snapshot).catch(() => undefined);
        await restoreTextFile(tool.skillPath, previousSkill).catch(() => undefined);
        throw new CliError('AGENT_UNINSTALL_FAILED', `${name} 移除失败，已恢复配置`, {
          cause: error,
        });
      }
    }
    return result;
  }

  async doctor(selection: AgentClientSelection): Promise<Record<string, unknown>> {
    const status = await this.status(selection);
    const checks = Object.entries(status).map(([client, value]) => ({
      client,
      ok: value.installed && value.configured && value.managed && value.current && value.skill_current,
      installed: value.installed,
      configured: value.configured,
      managed: value.managed,
      current: value.current === true,
      migration_available: value.migration_available === true,
      skill_installed: value.skill_installed,
      skill_current: value.skill_current,
      version: value.version,
      remedy: !value.installed
        ? `请先安装 ${client === 'codex' ? 'Codex' : 'Claude Code'}`
        : !value.managed || !value.skill_current
          ? `运行 zhicui agent setup --client ${client}`
          : null,
    }));
    return {
      ok: checks.every((item) => item.ok),
      node: process.version,
      platform: process.platform,
      checks,
    };
  }

  private names(selection: AgentClientSelection): AgentClientName[] {
    return selection === 'all' ? ['codex', 'claude'] : [selection];
  }
}
