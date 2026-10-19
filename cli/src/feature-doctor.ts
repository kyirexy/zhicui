import type { AgentApiClient } from './api-client.js';
import { CliError, EXIT_CODES } from './errors.js';
import { isJsonObject, type JsonObject } from './types.js';

type ActionStatus = 'accessible' | 'not_published' | 'scope_missing'
  | 'service_unavailable' | 'auth_required' | 'unknown';
type DiscoveryStatus = 'available' | 'service_unavailable' | 'auth_required' | 'unknown';

interface FeatureDefinition {
  id: string;
  title: string;
  actionIds: readonly string[];
  note: string;
}

const FEATURES: readonly FeatureDefinition[] = [
  { id: 'library', title: '视频资料', actionIds: ['library.list', 'library.get'],
    note: '查看当前账号已有视频资料；批量转写、删除与云端同步需另查对应 Action。' },
  { id: 'sync_recap', title: '同步与回顾', actionIds: [
    'library.activity.list', 'library.activity.record', 'library.sync.progress', 'library.recap.get',
    'local.platform.status', 'local.platform.sync', 'local.platform.cancel',
  ], note: '本机同步另需同账号桌面桥和本人平台会话；本次不检查、不启动桌面，也不发起同步。' },
  { id: 'extract', title: '单条提取', actionIds: ['library.import_link', 'library.transcript.generate'],
    note: '明确链接的导入与文稿提取；operation 的实际可选值见 input_constraints，不等于完整 AI 提取。' },
  { id: 'creator', title: '博主目录', actionIds: [
    'creator.list', 'creator.get', 'creator.items.list', 'creator.resolve', 'creator.create',
    'creator.sync.start', 'creator.sync.get', 'creator.sync.items.list', 'creator.sync.cancel', 'creator.runs.list',
  ], note: '查看已有博主、解析主页、目录同步是不同动作；平台连接器与真实主页/目录健康均未验证，单视频下载成功不能替代。' },
  { id: 'download', title: '视频下载', actionIds: ['library.media.resolve', 'library.media.download'],
    note: 'CLI 可通过安全直连接收媒体；download 的 mcp_exposed=false 不表示 CLI 不可用。未实际下载或验证平台媒体。' },
  { id: 'ask', title: '知萃 AI 问答', actionIds: [
    'ask.sources.list', 'ask.sources.search', 'ask.thread.list', 'ask.thread.get', 'ask.thread.create',
    'ask.thread.update', 'ask.thread.remove', 'ask.turn.start', 'ask.turn.get', 'ask.turn.events',
    'ask.turn.cancel', 'ask.turn.retry',
  ], note: 'web_scope 的实际可选值见 input_constraints；文稿问答可用不等于已开放联网研究。' },
  { id: 'daily_research', title: '每日研究', actionIds: [],
    note: '产品有独立 REST 流程，但当前 CLI/Agent Registry 未适配；automation.* 不能替代每日研究。' },
  { id: 'knowledge', title: '我的知识', actionIds: [
    'knowledge.list', 'knowledge.get', 'knowledge.create', 'knowledge.update', 'knowledge.remove',
  ], note: '知识页的读取与编辑分别需要相应 scope；未执行创建、修改或删除。' },
  { id: 'plan', title: '行动计划', actionIds: [
    'plan.list', 'plan.get', 'plan.overview', 'plan.create', 'plan.update', 'plan.remove',
    'plan.task.add', 'plan.task.update', 'plan.task.set_completion', 'plan.task.remove',
    'plan.focus.replace', 'plan.task.reorder', 'plan.review',
    'plan.from_library.generate', 'plan.coach.preview', 'plan.coach.apply',
  ], note: '手动计划/任务、从视频生成计划与 AI 调整是不同能力，必须分别检查发布和授权。' },
  { id: 'analysis', title: '视频画面分析', actionIds: [
    'analysis.catalog', 'analysis.runs.list', 'analysis.account.get', 'analysis.run.prepare',
    'analysis.run.confirm', 'analysis.run.get', 'analysis.run.cancel',
  ], note: '可见性不代表画面模型、额度或解析 worker 已健康；实际解析仍需报价与用户确认，本次不触发。' },
  { id: 'studio', title: '创作工坊', actionIds: [],
    note: '产品有独立视频创作 REST 流程，但当前 CLI/Agent Registry 未适配；切换发布档位不会自动补齐适配。' },
];

interface PublishedAction {
  id: string;
  scopes: string[];
  executionLocation: 'cloud' | 'local_windows';
  available: boolean | null;
  constraints: JsonObject;
}

interface Discovery {
  status: DiscoveryStatus;
  actions: Map<string, PublishedAction>;
  enabled: boolean | null;
  profile: string | null;
  errorCode: string | null;
}

function enumConstraints(value: unknown): JsonObject {
  if (!isJsonObject(value) || !isJsonObject(value.properties)) return {};
  const result: JsonObject = {};
  for (const key of ['operation', 'auto_transcribe', 'web_scope']) {
    const field = value.properties[key];
    if (isJsonObject(field) && Array.isArray(field.enum)) {
      result[key] = field.enum.filter(item => typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number');
    }
  }
  return result;
}

function parseDiscovery(value: unknown): Discovery {
  const base: Discovery = { status: 'unknown', actions: new Map(), enabled: null, profile: null, errorCode: 'INVALID_CAPABILITIES' };
  if (!isJsonObject(value)) return base;
  base.profile = ['core', 'video_intake', 'full'].includes(String(value.release_profile))
    ? String(value.release_profile) : null;
  base.enabled = typeof value.feature_enabled === 'boolean' ? value.feature_enabled : null;
  if (base.enabled === false) return { ...base, status: 'service_unavailable', errorCode: 'INTERFACE_DISABLED' };
  if (!Array.isArray(value.actions)) return base;
  for (const raw of value.actions) {
    if (!isJsonObject(raw) || typeof raw.id !== 'string' || !raw.id || base.actions.has(raw.id)) return base;
    // scopes 是单个 Action 的要求；顶层 scopes 只是全服务可授权目录。
    const scopes = Array.isArray(raw.scopes)
      ? raw.scopes.filter((scope): scope is string => typeof scope === 'string' && /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/u.test(scope))
      : [];
    base.actions.set(raw.id, {
      id: raw.id,
      scopes,
      executionLocation: raw.execution_location === 'local_windows' ? 'local_windows' : 'cloud',
      available: typeof raw.available === 'boolean' ? raw.available : null,
      constraints: enumConstraints(raw.input_schema),
    });
  }
  return { ...base, status: 'available', errorCode: null };
}

function failedDiscovery(error: unknown): Discovery {
  let status: DiscoveryStatus = 'unknown';
  let errorCode = 'DISCOVERY_FAILED';
  // 诊断只返回已知安全错误码，绝不透传远端 message/details、令牌或用户标识。
  if (error instanceof CliError) {
    if (error.exitCode === EXIT_CODES.authentication) {
      status = 'auth_required';
      errorCode = 'AUTH_REQUIRED';
    } else if (['TIMEOUT', 'REQUEST_TIMEOUT', 'REMOTE_FAILURE', 'RATE_LIMITED', 'INTERFACE_DISABLED', 'INTERFACE_PROFILE_INVALID', 'HTTP_404'].includes(error.code)
      || /^HTTP_5\d{2}$/u.test(error.code)) {
      status = 'service_unavailable';
      errorCode = error.code;
    } else if (error.code === 'FORBIDDEN' || error.code === 'SCOPE_DENIED') {
      errorCode = 'DISCOVERY_FORBIDDEN';
    }
  }
  return { status, actions: new Map(), enabled: null, profile: null, errorCode };
}

function discoveryReport(discovery: Discovery): JsonObject {
  return {
    status: discovery.status,
    action_count: discovery.status === 'available' ? discovery.actions.size : null,
    feature_enabled: discovery.enabled,
    error_code: discovery.errorCode,
  };
}

function nextStep(status: ActionStatus, action: PublishedAction | undefined, id: string): string {
  if (status === 'accessible') return `服务声明可调用，尚未执行；用 zhicui run describe ${id} --json 查看参数和确认要求。`;
  if (status === 'not_published') return '当前公开能力中没有此动作；需服务端发布该能力，再运行 zhicui doctor --json。重复登录不会增加发布范围。';
  if (status === 'scope_missing') return `确认要使用后，在知萃 Agent 授权管理中为当前 Agent 补充所需范围（${action?.scopes.join('、') || '以 Action 描述为准'}），再运行 zhicui doctor --json；本次不会发起授权。`;
  if (status === 'auth_required') return '当前凭据缺失或已失效；先用 zhicui auth status --json 检查，再按需执行一次 zhicui auth login。本次不发起登录。';
  if (status === 'service_unavailable') return '服务或能力发现暂不可用；检查服务状态并稍后重试 zhicui doctor --json。不要据此重新授权。';
  if (action?.executionLocation === 'local_windows') return '云端描述不能证明本机桥可用；确认已有同账号桌面客户端和平台会话后，按需检查 zhicui local status --json。本次未检查或启动桌面。';
  return '现有发现证据不足或不一致；稍后重试 zhicui doctor --json，并检查 zhicui capabilities --public --json；不要据此重新授权。';
}

function diagnoseAction(id: string, published: Discovery, credential: Discovery): JsonObject {
  const advertised = published.actions.get(id), visible = credential.actions.get(id);
  const definition = advertised ?? visible;
  let status: ActionStatus;
  if (published.status === 'service_unavailable') status = 'service_unavailable';
  else if (published.status !== 'available') status = 'unknown';
  else if (!advertised) status = visible ? 'unknown' : 'not_published';
  else if (credential.status === 'service_unavailable') status = 'service_unavailable';
  else if (credential.status === 'auth_required') status = 'auth_required';
  else if (credential.status !== 'available') status = 'unknown';
  else if (!visible) status = advertised.scopes.length ? 'scope_missing' : 'unknown';
  else if (advertised.executionLocation !== visible.executionLocation) status = 'unknown';
  else if (advertised.available === false || visible.available === false) {
    status = definition?.executionLocation === 'local_windows' ? 'unknown' : 'service_unavailable';
  } else if (advertised.available === true && visible.available === true) status = 'accessible';
  else status = 'unknown';
  return {
    id, status,
    required_scopes: definition?.scopes ?? [],
    execution_location: definition?.executionLocation ?? null,
    input_constraints: definition?.constraints ?? {},
    next_step: nextStep(status, definition, id),
  };
}

function statusCounts(actions: JsonObject[]): JsonObject {
  const counts: JsonObject = {};
  for (const action of actions) {
    const status = String(action.status);
    counts[status] = Number(counts[status] ?? 0) + 1;
  }
  return counts;
}

/** 只读能力发现：不运行 Action、不探测或启动桌面、不发起设备授权。 */
export async function diagnoseFeatures(client: AgentApiClient): Promise<JsonObject> {
  const results = await Promise.allSettled([client.publicCapabilities(), client.capabilities()]);
  const [published, credential] = results.map(result => result.status === 'fulfilled'
    ? parseDiscovery(result.value) : failedDiscovery(result.reason));
  const allActions: JsonObject[] = [];
  const features: JsonObject[] = FEATURES.map(feature => {
    const actions = feature.actionIds.map(id => diagnoseAction(id, published, credential));
    allActions.push(...actions);
    return {
      id: feature.id,
      title: feature.title,
      ...(actions.length ? {} : { status: 'not_integrated' }),
      actions,
      status_counts: statusCounts(actions),
      note: feature.note,
      next_step: actions.length
        ? '按各动作的 status 与 next_step 判断；同一入口可能同时存在可调用、缺授权和未发布的动作。'
        : '当前使用知萃客户端的该入口；CLI/MCP 需正式新增 Action 适配，重新登录或切换 full 不会补齐。',
    };
  });
  return {
    schema_version: 1,
    read_only: true,
    release_profile: published.profile,
    execution_verified: false,
    connector_health: 'not_checked',
    discovery: { public: discoveryReport(published), credential: discoveryReport(credential) },
    status_meanings: {
      accessible: '公开清单与当前凭据均声明可调用；未实际运行，不保证业务依赖健康。',
      not_published: '公开能力清单中没有此动作。',
      scope_missing: '公开清单存在此动作且要求 scope，但当前凭据发现成功后未返回该动作。',
      service_unavailable: '服务/发现请求失败，或云端动作明确声明不可用；不是缺 scope 的证据。',
      auth_required: '当前凭据缺失或无效，无法判断已获范围。',
      unknown: '发现证据不足、不一致，或本机执行条件尚未检查。',
      not_integrated: '现有 CLI/Agent Registry 尚未适配该产品入口。',
    },
    status_counts: { ...statusCounts(allActions), not_integrated: FEATURES.filter(feature => !feature.actionIds.length).length },
    features,
  };
}
