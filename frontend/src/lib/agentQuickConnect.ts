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
如果还没有工具，请引导我打开知萃电脑客户端侧边栏的「Agent 接入」，选择我正在使用的 Agent，点击「安装连接」并在客户端确认授权。已有 CLI 时可以运行 zhicui auth login；个人访问令牌在 https://luxai.cn/agent-access 创建。不要假定 npm 包可用，也不要使用旧的测试安装目录。
如果连接已安装但当前会话没有工具，请提示重启知萃 MCP 或重新连接后再检查。若知萃提示云端接入尚未开放，请明确说明原因，不要反复安装。
连接后先只读查看可用能力和我的视频资料，告诉我可以分析哪些内容；只有可用能力明确包含同步、导入或解析，且我指定视频或博主后，才执行相应操作。文稿未准备好时先查询进度，不要声称已经能够提取。
不要让我在聊天中粘贴密码、Cookie、JWT、访问令牌或 API Key。需要授权时，由我在知萃客户端确认。`;

export const CORE_AGENT_LOGIN_COMMAND = 'zhicui auth login --scopes account:read,library:read,ask:read,ask:run';

export const AGENT_CORE_HANDOFF_PROMPT = `请帮我连接知萃的基础接入能力。先检查当前会话能否发现知萃 MCP 工具，并读取可用能力与已授权权限。
已有知萃 CLI 时，运行 ${CORE_AGENT_LOGIN_COMMAND}，由我在浏览器中核对并确认授权。也可以在 https://luxai.cn/agent-access 创建按需授权的个人访问令牌；不要让我把令牌粘贴进聊天。
目前可以读取知萃已保存的资料和文稿，基于已有文稿问答，并在获得相应权限后整理知识和计划。请先只读查看我的资料，等我指定内容后再问答或写入。
基础接入已开放抖音、B站公开链接的导入、文稿提取和视频下载，对应 library.import_link、library.transcript.generate、library.media.download。只处理我明确指定的公开链接；操作前检查可用能力，并确认已获得 library:write 授权。缺少权限时，引导我在浏览器授权页按需追加授权，或创建包含该权限的个人访问令牌；不要自动扩大默认权限。
文稿提取尚未完成时先查询任务进度，不要声称已取得文稿或视频文件。当前基础接入仍不开放平台账号批量同步、本机桥接（bridge）或视觉自动化，不要尝试调用这些能力。
不要读取或展示密码、Cookie、JWT、访问令牌或 API Key。`;
