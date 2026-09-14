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
如果还没有工具，请引导我打开知萃电脑客户端的「设置 → Agent 接入」，选择我正在使用的 Agent，点击「安装连接」并在客户端确认授权。不要假定 npm 包可用，也不要使用旧的测试安装目录。
如果连接已安装但当前会话没有工具，请提示重启知萃 MCP 或重新连接后再检查。若知萃提示云端接入尚未开放，请明确说明原因，不要反复安装。
连接后先只读查看可用能力和我的视频资料，告诉我可以分析哪些内容；等我指定视频或博主再执行同步、导入或分析。文稿未准备好时，先查询进度。
不要让我在聊天中粘贴密码、Cookie、JWT、访问令牌或 API Key。需要授权时，由我在知萃客户端确认。`;
