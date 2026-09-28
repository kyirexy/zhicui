"""发布已经通过 GitHub 来源验证的官网 CLI 包；不重启应用或改变 Agent 权限。"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

parser=argparse.ArgumentParser()
parser.add_argument('artifacts')
parser.add_argument('--expected-commit',required=True)
parser.add_argument('--expected-sha256',required=True)
parser.add_argument('--expected-nginx-sha256',required=True)
args=parser.parse_args()
source=Path(args.artifacts).resolve(strict=True)
if source.parent != Path('/home/ubuntu') or not re.fullmatch(r'zhicui-cli-web-\d+\.\d+\.\d+',source.name):
    raise SystemExit('非法发行目录')
manifest=json.loads((source/'release.json').read_text())
version=manifest['version']
if not re.fullmatch(r'\d+\.\d+\.\d+',version) or manifest['filename'] != f'zhicui-cli-{version}.tgz' or manifest['commit'] != args.expected_commit:
    raise SystemExit('发行版本或提交不符')
package=source/manifest['filename']
digest=hashlib.sha256(package.read_bytes()).hexdigest()
if digest != manifest['sha256'] or digest != args.expected_sha256 or package.stat().st_size != manifest['bytes']:
    raise SystemExit('安装包校验不符')
snippet=Path('/etc/nginx/snippets/zhicui-windows-updates.conf')
if hashlib.sha256(snippet.read_bytes()).hexdigest() != args.expected_nginx_sha256:
    raise SystemExit('Nginx 配置已变化，请重新审阅差异')
destination=Path('/var/lib/zhicui-downloads/cli')
if destination.is_symlink(): raise SystemExit('发行目录不可为软链接')
destination.mkdir(mode=0o755,exist_ok=True)
immutable=destination/package.name
if immutable.exists() and hashlib.sha256(immutable.read_bytes()).hexdigest()!=digest:
    raise SystemExit('拒绝覆盖不同内容的既有版本')

def atomic_copy(src,dst):
    temporary=dst.with_name('.'+dst.name+'.'+str(os.getpid())+'.tmp')
    shutil.copyfile(src,temporary)
    os.chmod(temporary,0o644)
    os.replace(temporary,dst)

atomic_copy(package,immutable)
for name in ('index.html','site.css','site.js','SHA256SUMS','release.json'):
    atomic_copy(source/name,destination/name)
atomic_copy(package,destination/'cli.tgz')
backup=snippet.with_name(snippet.name+'.cli-backup-'+time.strftime('%Y%m%dT%H%M%S'))
subprocess.run(['sudo','-n','cp','-p',str(snippet),str(backup)],check=True)
subprocess.run(['sudo','-n','install','-m','0644',str(source/'nginx-windows-updates.conf'),str(snippet)],check=True)
try:
    subprocess.run(['sudo','-n','nginx','-t'],check=True)
    subprocess.run(['sudo','-n','systemctl','reload','nginx'],check=True)
except BaseException:
    subprocess.run(['sudo','-n','cp','-p',str(backup),str(snippet)],check=True)
    subprocess.run(['sudo','-n','nginx','-t'],check=True)
    subprocess.run(['sudo','-n','systemctl','reload','nginx'],check=True)
    raise
print(json.dumps({'published':True,'version':version,'sha256':digest,'install_url':'https://luxai.cn/cli.tgz','guide':'https://luxai.cn/cli','nginx_backup':str(backup)}))
