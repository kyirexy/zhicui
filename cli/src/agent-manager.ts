import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliError, EXIT_CODES } from './errors.js';
import { redactedProcessMessage, runProcess } from './process-utils.js';

export type AgentClientName = 'codex' | 'claude';
export type AgentClientSelection = AgentClientName | 'all';

interface KnownTool {
  name: AgentClientName;
  command: string;
  prefixArgs: string[];
  configPath: string;
  skillPath: string;
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

async function resolveCommand(name: AgentClientName): Promise<string | null> {
  if (envCommand(name)) return envCommand(name)!;
  const lookup = process.platform === 'win32'
    ? await runProcess('where.exe', [name], { allowFailure: true })
    : await runProcess('/usr/bin/env', ['which', name], { allowFailure: true });
  if (lookup.code !== 0) return null;
  const candidates = lookup.stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean);
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
  return null;
}

function configPath(name: AgentClientName): string {
  const override = process.env[`ZHICUI_${name.toUpperCase()}_CONFIG`];
  if (override) return override;
  if (name === 'codex') {
    return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
  }
  return join(homedir(), '.claude.json');
}

function skillPath(name: AgentClientName): string {
  const override = process.env[`ZHICUI_${name.toUpperCase()}_SKILLS_DIR`];
  const root = override || (name === 'codex'
    ? join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'skills')
    : join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'skills'));
  return join(root, 'zhicui', 'SKILL.md');
}

async function knownTool(name: AgentClientName): Promise<KnownTool | null> {
  const command = await resolveCommand(name);
  if (!command) return null;
  return {
    name,
    command,
    prefixArgs: envPrefixArgs(name),
    configPath: configPath(name),
    skillPath: skillPath(name),
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
      timeoutMs: options.timeoutMs,
    });
  }
  return runProcess(tool.command, fullArgs, options);
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
): Promise<void> {
  const path = configProvenancePath(tool.configPath);
  if (await exists(path)) {
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

function exactClaudeCommandSpec(
  value: unknown,
  expected: ReturnType<typeof selfMcpCommand>,
): boolean {
  if (!isRecord(value)) return false;

  // Claude user-scoped stdio servers are stored at
  // ~/.claude.json -> mcpServers.<name>.  Only accept the fields Claude's
  // own `mcp add --scope user` writes for this transport.  Unknown fields
  // (for example cwd/alwaysLoad) can change execution semantics and must
  // therefore make the entry user-owned rather than CLI-owned.
  const allowedKeys = new Set(['type', 'command', 'args', 'env']);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) return false;
  if (value.type !== undefined && value.type !== 'stdio') return false;
  if (typeof value.command !== 'string') return false;
  if (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string')) {
    return false;
  }
  if (value.env !== undefined && !isRecord(value.env)) return false;

  const expectedArgs = [...expected.args, 'mcp', 'serve', '--stdio'];
  const actualArgs = value.args as string[];
  if (normalizeProbeValue(value.command) !== normalizeProbeValue(expected.command)) return false;
  if (actualArgs.length !== expectedArgs.length) return false;
  if (!actualArgs.every((arg, index) => (
    normalizeProbeValue(arg) === normalizeProbeValue(expectedArgs[index])
  ))) return false;

  const expectedEnvironment = [...expected.env].map(normalizeProbeValue).sort();
  const actualEnvironment = normalizedEnvironment(value.env);
  return actualEnvironment.length === expectedEnvironment.length
    && actualEnvironment.every((item, index) => item === expectedEnvironment[index]);
}

async function claudeConfigIsManaged(
  tool: KnownTool,
  expected: ReturnType<typeof selfMcpCommand>,
): Promise<boolean> {
  try {
    const root = JSON.parse(await readFile(tool.configPath, 'utf8')) as unknown;
    if (!isRecord(root) || !isRecord(root.mcpServers)) return false;
    return exactClaudeCommandSpec(root.mcpServers[SERVER_NAME], expected);
  } catch {
    // Missing, unreadable, or invalid JSON cannot prove ownership.  Fail
    // closed so update/uninstall never overwrites a merely similar entry.
    return false;
  }
}

function exactCommandSpec(value: unknown, expected: ReturnType<typeof selfMcpCommand>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (
    typeof item.command === 'string'
    && Array.isArray(item.args)
    && item.args.every((arg) => typeof arg === 'string')
    && normalizeProbeValue(item.command) === normalizeProbeValue(expected.command)
  ) {
    const actualArgs = item.args as string[];
    const expectedEnvironment = [...expected.env].map(normalizeProbeValue).sort();
    const actualEnvironment = normalizedEnvironment(item.env);
    if (
      actualArgs.length === expected.args.length + 3
      && actualArgs.every((arg, index) => normalizeProbeValue(arg) === normalizeProbeValue(
        [...expected.args, 'mcp', 'serve', '--stdio'][index],
      ))
      && actualEnvironment.length === expectedEnvironment.length
      && actualEnvironment.every((item, index) => item === expectedEnvironment[index])
    ) return true;
  }
  return Object.values(item).some((child) => exactCommandSpec(child, expected));
}

async function managedProbe(tool: KnownTool, stdout: string): Promise<boolean> {
  const expected = selfMcpCommand();
  if (tool.name === 'codex') {
    try {
      return exactCommandSpec(JSON.parse(stdout), expected);
    } catch {
      return false;
    }
  }
  return claudeConfigIsManaged(tool, expected);
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
  const installedSkill = await exists(tool.skillPath)
    ? await readFile(tool.skillPath, 'utf8')
    : null;
  const skillInstalled = Boolean(installedSkill?.includes(MANAGED_MARKER));
  const skillCurrent = skillInstalled && installedSkill === await managedSkillSource();
  return {
    installed: true,
    version: version.stdout.trim() || version.stderr.trim(),
    configured: isConfigured,
    managed: isConfigured && await managedProbe(tool, configured.stdout),
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

  async status(selection: AgentClientSelection): Promise<Record<string, ClientProbe>> {
    const result: Record<string, ClientProbe> = {};
    for (const name of this.names(selection)) {
      try {
        const tool = await knownTool(name);
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
      const tool = await knownTool(name);
      if (!tool) {
        result[name] = { installed: false, changed: false, error: `${name} 未安装` };
        continue;
      }
      const before = await rawProbe(tool);
      if (before.managed && before.skill_current) {
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
      const snapshot = before.configured ? null : await snapshotConfig(tool.configPath);
      const previousSkill = await exists(tool.skillPath)
        ? await readFile(tool.skillPath, 'utf8')
        : null;
      let provenanceCreated = false;
      try {
        if (!before.configured) await addMcp(tool);
        const skill = await installSkill(tool.skillPath);
        const after = await rawProbe(tool);
        if (!after.configured || !after.managed || !after.skill_current) {
          throw new CliError('AGENT_SETUP_FAILED', `${name} 配置校验失败`);
        }
        if (snapshot) {
          await writeConfigProvenance(tool, snapshot);
          provenanceCreated = true;
        }
        result[name] = {
          ...after,
          changed: true,
          skill_changed: skill.changed,
          backup_created: Boolean(snapshot?.backup || skill.backup),
        };
      } catch (error) {
        if (provenanceCreated) {
          await rm(configProvenancePath(tool.configPath), { force: true }).catch(() => undefined);
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

  async uninstall(selection: AgentClientSelection): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const name of this.names(selection)) {
      const tool = await knownTool(name);
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
      ok: value.installed && value.configured && value.managed && value.skill_current,
      installed: value.installed,
      configured: value.configured,
      managed: value.managed,
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
