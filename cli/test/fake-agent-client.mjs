import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const [client, ...args] = process.argv.slice(2);
const upper = client.toUpperCase();
const statePath = process.env[`FAKE_${upper}_STATE`];
const configPath = process.env[`ZHICUI_${upper}_CONFIG`];
const state = JSON.parse(await readFile(statePath, 'utf8').catch(() => '{"configured":false,"add_count":0}'));

async function save() {
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state));
  await mkdir(dirname(configPath), { recursive: true });
  const original = await readFile(configPath, 'utf8').catch(() => (
    client === 'claude' ? '{}' : 'user_setting=true\n'
  ));
  if (client === 'claude') {
    const config = JSON.parse(original);
    config.mcpServers ||= {};
    if (state.configured) {
      config.mcpServers.zhicui = {
        type: 'stdio',
        command: state.command,
        args: state.args || [],
      };
    } else {
      delete config.mcpServers.zhicui;
      if (Object.keys(config.mcpServers).length === 0) delete config.mcpServers;
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return;
  }
  const withoutManaged = original.replace(/\n?# zhicui fake managed[\s\S]*$/u, '');
  await writeFile(configPath, `${withoutManaged}\n# zhicui fake managed\nconfigured=${state.configured}\n`);
}

if (args[0] === '--version') {
  console.log(`${client} test 1.0.0`);
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'get') {
  if (!state.configured) process.exit(1);
  if (process.env.FAKE_AGENT_FAIL_GET_AFTER_ADD === client && state.add_count > 0) process.exit(2);
  if (client === 'codex') {
    console.log(JSON.stringify({ command: state.command, args: state.args }));
  } else {
    console.log(`zhicui: ${state.command} ${(state.args || []).join(' ')}`);
  }
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'add') {
  if (process.env.FAKE_AGENT_FAIL_ADD === client) process.exit(2);
  const separator = args.indexOf('--');
  if (separator < 0 || !args[separator + 1]) process.exit(2);
  state.configured = true;
  state.add_count += 1;
  state.command = args[separator + 1];
  state.args = args.slice(separator + 2);
  await save();
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'remove') {
  state.configured = false;
  state.remove_count = (state.remove_count || 0) + 1;
  await save();
  process.exit(0);
}
process.exit(2);
