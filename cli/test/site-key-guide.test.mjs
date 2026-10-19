import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../site/site.js', import.meta.url), 'utf8');

test('官网首屏引导生成密钥，手动命令和设备授权只在折叠的高级设置中', () => {
  const [primary, advanced] = html.split('<details class="advanced">');
  assert.match(primary, /生成 Agent 密钥/);
  assert.match(primary, /复制给 Agent/);
  assert.match(primary, /href="\/agent-access"/);
  assert.doesNotMatch(primary, /zhicui (?:connect|auth login|sync)/);
  assert.match(advanced, /connect --pat-stdin --client codex --non-interactive --json/);
  assert.match(advanced, /zhicui auth login/);
  assert.doesNotMatch(html, /后台读取最近喜欢|自动同步|creator\.sync|zhicui sync/);
});

async function siteRuntime(manifest) {
  const elements = new Map();
  const clipboard = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { value: 'codex', textContent: '', disabled: selector === '#copy', events: {}, addEventListener(name, handler) { this.events[name] = handler; } });
    return elements.get(selector);
  };
  vm.runInNewContext(script, {
    document: { querySelector: element },
    navigator: { clipboard: { writeText: async text => clipboard.push(text) } },
    fetch: async () => ({ ok: true, json: async () => manifest }),
  });
  await new Promise(resolve => setImmediate(resolve));
  return { element, clipboard };
}

test('官网复制命令只安装包，不暗中发起设备登录；客户端切换保留标准输入密钥接入', async () => {
  const { element, clipboard } = await siteRuntime({ version: '1.0.21', download_url: 'https://luxai.cn/download/cli/zhicui-cli-1.0.21.tgz' });
  assert.equal(element('#copy').disabled, false);
  await element('#copy').events.click();
  assert.deepEqual(clipboard, ['npm install -g https://luxai.cn/cli.tgz']);
  element('#client').value = 'claude';
  element('#client').events.change();
  assert.equal(element('#key-command').textContent, 'zhicui connect --pat-stdin --client claude --non-interactive --json');
  assert.match(element('#status').textContent, /生成密钥/);
});

test('无效发行信息不开放复制安装按钮', async () => {
  const { element } = await siteRuntime({ version: '1.0.21', download_url: 'https://example.com/cli.tgz' });
  assert.equal(element('#copy').disabled, true);
  assert.match(element('#command').textContent, /暂时无法读取/);
});
