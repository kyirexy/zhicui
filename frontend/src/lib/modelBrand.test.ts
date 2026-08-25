import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModelBrand } from './modelBrand.ts';

test('按真实模型 ID 识别截图中的平台模型', () => {
  assert.equal(resolveModelBrand({ name: '免费模型', modelId: 'deepseek-ai/DeepSeek-V3' }), 'deepseek');
  assert.equal(resolveModelBrand({ name: 'mimo-v2.5-free', modelId: 'oc/mimo-v2.5-free' }), 'mimo');
  assert.equal(resolveModelBrand({ name: 'hy3-free', modelId: 'oc/hy3-free' }), 'hunyuan');
  assert.equal(resolveModelBrand({ name: 'Felo Chat', modelId: 'felo/felo-chat' }), 'felo');
});

test('兼容常见供应商与展示名别名', () => {
  assert.equal(resolveModelBrand({ name: '通义千问' }), 'qwen');
  assert.equal(resolveModelBrand({ modelId: 'moonshot/kimi-k2' }), 'kimi');
  assert.equal(resolveModelBrand({ modelId: 'openai/gpt-5' }), 'openai');
  assert.equal(resolveModelBrand({ provider: '自带供应商', code: 'custom:one' }), 'custom');
});
