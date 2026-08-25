export type ModelBrand =
  | 'anthropic'
  | 'azure'
  | 'baidu'
  | 'bedrock'
  | 'claude'
  | 'cohere'
  | 'deepseek'
  | 'doubao'
  | 'felo'
  | 'gemini'
  | 'grok'
  | 'groq'
  | 'huggingface'
  | 'hunyuan'
  | 'kimi'
  | 'meta'
  | 'mimo'
  | 'minimax'
  | 'mistral'
  | 'nvidia'
  | 'ollama'
  | 'openai'
  | 'opencode'
  | 'openrouter'
  | 'perplexity'
  | 'qwen'
  | 'siliconcloud'
  | 'vertex'
  | 'volcengine'
  | 'zhipu'
  | 'custom'
  | 'platform'
  | 'unknown';

export interface ModelBrandIdentity {
  code?: string | null;
  modelId?: string | null;
  name?: string | null;
  provider?: string | null;
}

/**
 * 模型品牌以真实 model_id 为主，同时兼容后台展示名与供应商别名。
 * 保持为纯函数，用户端模型选择器和管理端可以共享完全相同的结果。
 */
export function resolveModelBrand(identity: ModelBrandIdentity): ModelBrand {
  const value = [identity.modelId, identity.code, identity.name, identity.provider]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('zh-CN');

  if (/\b(openai|gpt[-_\s]?\d|chatgpt)\b/.test(value)) return 'openai';
  if (value.includes('claude')) return 'claude';
  if (value.includes('anthropic')) return 'anthropic';
  if (value.includes('gemini') || value.includes('google ai')) return 'gemini';
  if (value.includes('deepseek') || value.includes('深度求索')) return 'deepseek';
  if (value.includes('mimo') || value.includes('xiaomi') || value.includes('小米大模型')) return 'mimo';
  if (/\bhy3(?:\b|[-_/])/.test(value) || value.includes('hunyuan') || value.includes('混元')) return 'hunyuan';
  if (value.includes('felo')) return 'felo';
  if (value.includes('qwen') || value.includes('千问') || value.includes('通义')) return 'qwen';
  if (value.includes('doubao') || value.includes('豆包')) return 'doubao';
  if (value.includes('kimi') || value.includes('moonshot') || value.includes('月之暗面')) return 'kimi';
  if (value.includes('minimax') || value.includes('海螺')) return 'minimax';
  if (value.includes('mistral')) return 'mistral';
  if (value.includes('llama') || value.includes('meta ai') || value.includes('meta-ai')) return 'meta';
  if (value.includes('grok') || value.includes('xai')) return 'grok';
  if (value.includes('groq')) return 'groq';
  if (value.includes('nvidia') || value.includes('nemotron')) return 'nvidia';
  if (value.includes('ollama')) return 'ollama';
  if (value.includes('siliconflow') || value.includes('silicon cloud') || value.includes('硅基流动')) return 'siliconcloud';
  if (value.includes('openrouter')) return 'openrouter';
  if (value.includes('opencode')) return 'opencode';
  if (value.includes('cohere') || value.includes('command-r')) return 'cohere';
  if (value.includes('huggingface') || value.includes('hugging face')) return 'huggingface';
  if (value.includes('perplexity')) return 'perplexity';
  if (value.includes('azure')) return 'azure';
  if (value.includes('bedrock')) return 'bedrock';
  if (value.includes('vertex')) return 'vertex';
  if (value.includes('baidu') || value.includes('ernie') || value.includes('文心')) return 'baidu';
  if (value.includes('volcengine') || value.includes('火山引擎')) return 'volcengine';
  if (value.includes('zhipu') || value.includes('glm') || value.includes('智谱')) return 'zhipu';
  if (value.includes('__custom__') || value.includes('custom:') || value.includes('自带供应商')) return 'custom';
  if (value.includes('__platform__')) return 'platform';
  return 'unknown';
}
