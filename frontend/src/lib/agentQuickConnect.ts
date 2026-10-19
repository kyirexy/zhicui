export const DAILY_AGENT_SCOPES = [
  'account:read', 'library:read', 'library:write', 'creator:read',
  'ask:read', 'ask:run', 'local:invoke',
] as const;

export const READ_ONLY_AGENT_SCOPES = [
  'account:read', 'library:read', 'creator:read', 'ask:read',
] as const;

export type AgentScopePreset = 'daily' | 'read-only' | 'custom';

// 仅用于新连接的申请表；已有凭据始终保留服务端实际授予的权限。
export function agentPresetScopes(
  preset: AgentScopePreset,
  availableScopes: readonly string[],
  customScopes: readonly string[] = [],
): string[] {
  const available = new Set(availableScopes);
  const requested = preset === 'daily' ? DAILY_AGENT_SCOPES
    : preset === 'read-only' ? READ_ONLY_AGENT_SCOPES : customScopes;
  return [...new Set(requested)].filter((scope) => available.has(scope));
}

export function agentLoginCommand(scopes: readonly string[] = DAILY_AGENT_SCOPES): string {
  const selected = [...new Set(scopes)].filter((scope) => /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/.test(scope));
  // 空权限不能省略 --scopes，否则 CLI 会意外恢复为默认预设。
  return selected.length ? `zhicui auth login --scopes '${selected.join(',')}'` : '';
}

export const CORE_AGENT_LOGIN_COMMAND = agentLoginCommand();
export const VIDEO_AGENT_LOGIN_COMMAND = CORE_AGENT_LOGIN_COMMAND;

export function agentPromptForCommand(prompt: string, command: string, preset: AgentScopePreset = 'daily'): string {
  const selected = preset === 'read-only'
    ? '本次我明确选择只读连接，不申请写入、问答运行或本机调用权限。后续任务确实需要更多权限时，再说明原因并由我确认。\n'
    : preset === 'custom' ? '本次使用我明确选择的自定义权限，请保留下面命令中的范围，不要替换为日常使用默认权限。\n' : '';
  return selected + prompt.replaceAll(CORE_AGENT_LOGIN_COMMAND, command);
}

// 安装、授权和工具检查分别判断；配置存在不代表已连接。
export interface AgentConnectionCheck {
  installed?: boolean;
  configured?: boolean;
  managed?: boolean;
  authenticated?: boolean;
  cloud_available?: boolean;
  mcp_healthy?: boolean;
  ready?: boolean;
  code?: string;
}

export function agentConnectionStep(input: {
  status?: AgentConnectionCheck;
  loading: boolean;
  interfaceDisabled: boolean;
  supportsAuthorization: boolean;
}): { label: string; description: string; action: 'setup' | 'authorize' | 'doctor'; ready: boolean } {
  const { status, loading, interfaceDisabled, supportsAuthorization } = input;
  if (loading && !status) return { label: '正在检查', description: '正在检查本机连接。', action: 'doctor', ready: false };
  if (!status?.configured || status.managed === false || status.code === 'AGENT_UPDATE_REQUIRED') return {
    label: '安装连接', description: '使用客户端自带的连接组件，同时安装 MCP 和使用说明。', action: 'setup', ready: false,
  };
  if (interfaceDisabled || status.code === 'INTERFACE_DISABLED') return {
    label: '连接已安装', description: '云端接入尚未开放，开放后即可继续授权。无需重复安装。', action: 'doctor', ready: false,
  };
  if (status.code === 'ROLLOUT_RESTRICTED') return {
    label: '连接已安装', description: '当前账号尚未开放 Agent 接入。无需重复授权。', action: 'doctor', ready: false,
  };
  if (!supportsAuthorization) return {
    label: '连接已安装', description: '更新知萃客户端后，可直接在这里完成授权和连接检查。', action: 'doctor', ready: false,
  };
  if (status.authenticated === false) return {
    label: '授权连接', description: '确认允许访问的资料后，就能交给 Agent 使用。', action: 'authorize', ready: false,
  };
  if (status.ready === true && status.authenticated === true && status.cloud_available === true && status.mcp_healthy === true) return {
    label: '连接检查通过', description: '回到 Agent 重启知萃 MCP 或重新连接，再粘贴使用提示词。', action: 'doctor', ready: true,
  };
  return { label: '检查连接', description: '连接已安装，继续检查授权与服务状态。', action: 'doctor', ready: false };
}

export const AGENT_HANDOFF_PROMPT = `请帮我接入并使用知萃。先检查当前会话是否能发现知萃 MCP 工具，不要仅凭 Skill 文件就判断已连接。
如果还没有工具，请引导我打开知萃电脑客户端侧边栏的「Agent 接入」，选择我正在使用的 Agent，点击「安装连接」并在客户端确认授权。已有 CLI 时可以运行 ${CORE_AGENT_LOGIN_COMMAND}；个人访问令牌在 https://luxai.cn/agent-access 创建。不要假定 npm 包可用，也不要使用旧的测试安装目录。
如果连接已安装但当前会话没有工具，请提示重启知萃 MCP 或重新连接后再检查。若知萃提示云端接入尚未开放，请明确说明原因，不要反复安装。
日常使用会一次申请当前服务支持的资料导入、文稿提取、下载、问答和本机按需同步权限。优先复用已有有效连接；只有尚未连接、凭据失效或明确缺少本次操作的权限时才发起授权，不要每次提取都重新登录，不要自动扩展已有凭据。
连接后先查看可用能力与已授权权限；只有我指定视频或博主，并且能力和权限均满足时，才执行相应操作。文稿未准备好时先查询进度，不要声称已经能够提取。
不要让我在聊天中粘贴密码、Cookie、JWT、访问令牌或 API Key。需要授权时，由我在知萃确认；优先使用已登录且支持授权的桌面客户端，无法打开时再使用同一个授权请求进入网页，不要求我重复登录。`;

export const VIDEO_AGENT_HANDOFF_PROMPT = `请用知萃准备我接下来指定的抖音或 B站视频，并把素材交给本机 Hypit。
先复用已有有效连接；首次连接可运行 ${VIDEO_AGENT_LOGIN_COMMAND}，在知萃一次核对当前服务支持的日常使用权限。已有连接只有失效或明确缺少本次任务所需权限时才重新授权，不要每次视频提取都重新登录，不要自动扩展已有凭据。
如果只需要原视频，CLI 1.0.7 起优先运行 zhicui download '<链接>' --connect --json，一条命令直接下载，不先提取文稿；只需 library:read 权限。只想获取下载入口时用 zhicui resolve '<链接>' --json，或调用已发现的 library.media.resolve / zhicui_library_media_resolve MCP 工具。
先检查知萃 CLI 版本；1.0.5 及以上可使用 zhicui library prepare '<我提供的链接或分享文字>' --connect --jsonl --timeout 10m。从我的 Hypit 项目目录运行，素材会保存在其中的 zhicui-media 目录。
如需授权，请让我在知萃确认；优先使用已登录且支持授权的桌面客户端，无法打开时再使用同一个授权请求进入网页，不要求我重复登录。确认后当前任务自动继续，不要让我在聊天中粘贴 PAT、密码或 Cookie。未指定视频前不要运行提取。
持续向我说明识别视频、提取文稿、下载视频的真实进度。中断后再次运行同一条命令即可继续；不要覆盖或删除原素材。遇到平台验证限制时保留进度并提示处理，不要连续重试。
只有 source.mp4 和 manifest.json 实际生成且通过校验后，才告诉我素材就绪，再交给本机 Hypit。素材就绪不代表复刻视频已经生成。`;

export const AGENT_CORE_HANDOFF_PROMPT = `请帮我连接知萃的日常使用能力。先检查当前会话能否发现知萃 MCP 工具，并读取可用能力与已授权权限。
只下载明确指定的公开视频时，可用 zhicui download '<链接>' --connect --json；快速入口能力为 library.media.resolve，只需 library:read，无需导入资料或提取文稿。
优先复用已有有效连接。首次连接运行 ${CORE_AGENT_LOGIN_COMMAND}，由我在知萃一次核对并确认当前服务支持的权限；优先使用已登录且支持授权的桌面客户端，无法打开时再使用同一个授权请求进入网页，不要求我重复登录。只在凭据失效或明确缺少本次任务权限时重新授权，不要每次视频提取都重新登录。也可以在 https://luxai.cn/agent-access 选择日常使用、只读或自定义权限创建个人访问令牌；不要让我把令牌粘贴进聊天。
目前可以读取知萃已保存的资料和文稿，基于已有文稿问答，并在获得相应权限后整理知识和计划。请先只读查看我的资料，等我指定内容后再问答或写入。
日常使用预设涵盖抖音、B站公开链接的导入、文稿提取和视频下载，对应 library.import_link、library.transcript.generate、library.media.download。只处理我明确指定的公开链接；操作前检查可用能力，并确认已获得 library:write 授权。自定义或已有只读连接若缺少该权限，再说明缺少什么并申请确认；不要自动扩大已有凭据的权限。
文稿提取尚未完成时先查询任务进度，不要声称已取得文稿或视频文件。本机按需同步仅在当前服务和客户端明确支持且已授予 local:invoke 时使用；未开放的平台账号批量同步、本机桥接或视觉自动化不可调用。
不要读取或展示密码、Cookie、JWT、访问令牌或 API Key。`;
