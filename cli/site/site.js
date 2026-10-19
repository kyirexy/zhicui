const client = document.querySelector('#client');
const command = document.querySelector('#command');
const keyCommand = document.querySelector('#key-command');
const copy = document.querySelector('#copy');
const status = document.querySelector('#status');

function updateKeyCommand() {
  const target = client.value === 'claude' ? 'claude' : 'codex';
  keyCommand.textContent = `zhicui connect --pat-stdin --client ${target} --non-interactive --json`;
}
client.addEventListener('change', updateKeyCommand);
copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(command.textContent);
    status.textContent = '已复制安装命令。安装后，在知萃生成密钥并使用“复制给 Agent”完成连接。';
  } catch {
    status.textContent = '浏览器未允许复制，请选中上方命令手动复制。';
  }
});
fetch('release.json', { cache: 'no-store' })
  .then(response => { if (!response.ok) throw Error(); return response.json(); })
  .then(data => {
    if (!/^\d+\.\d+\.\d+$/.test(data.version) || !/^https:\/\/luxai\.cn\/download\/cli\/zhicui-cli-\d+\.\d+\.\d+\.tgz$/.test(data.download_url)) throw Error();
    document.querySelector('#version').textContent = `v${data.version} · 已校验`;
    document.querySelector('#package').href = data.download_url;
    command.textContent = 'npm install -g https://luxai.cn/cli.tgz';
    copy.disabled = false;
  })
  .catch(() => { command.textContent = '版本信息暂时无法读取，请稍后刷新。'; });
