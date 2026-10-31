"""用真实临时 Git 远端核验直发目标，避免误发 master 或分歧分支。"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
HELPER=ROOT/'deploy/resolve-deploy-target.sh'
if os.name=='nt':
    git_path=shutil.which('git')
    candidate=Path(git_path).resolve().parents[1]/'bin/bash.exe' if git_path else None
    BASH=str(candidate) if candidate and candidate.is_file() else None
else:
    BASH=shutil.which('bash')

@unittest.skipUnless(BASH and shutil.which('git'), '需要 Git 与 Bash')
class DeployTargetResolutionTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.base=Path(self.tmp.name)
        self.remote=self.base/'remote.git'; self.seed=self.base/'seed'; self.work=self.base/'work'
        self.git('init','--bare',str(self.remote))
        self.git('init','-b','master',str(self.seed))
        self.git('-C',str(self.seed),'config','user.name','Release Test')
        self.git('-C',str(self.seed),'config','user.email','release@example.invalid')
        self.initial=self.commit('initial')
        self.git('-C',str(self.seed),'remote','add','origin',str(self.remote))
        self.git('-C',str(self.seed),'push','origin','master')
        self.git('clone',str(self.remote),str(self.work))
        self.git('-C',str(self.seed),'checkout','-b','approved-fix')
        self.target=self.commit('approved fix')
        self.git('-C',str(self.seed),'push','origin','approved-fix')
    def tearDown(self):
        self.tmp.cleanup()
    def git(self,*args):
        return subprocess.check_output(['git',*args],stderr=subprocess.DEVNULL,text=True).strip()
    def commit(self,text):
        (self.seed/'fixture.txt').write_text(text)
        self.git('-C',str(self.seed),'add','fixture.txt')
        self.git('-C',str(self.seed),'commit','-m',text)
        return self.git('-C',str(self.seed),'rev-parse','HEAD')
    def resolve(self,target=''):
        # 通过环境传参数；不把测试路径或 SHA 拼成可执行 Shell 文本。
        env={**os.environ,'HELPER':HELPER.as_posix(),'REQUESTED':target}
        return subprocess.run([BASH,'-c','source "$HELPER"; resolve_deploy_target "$REQUESTED"'],cwd=self.work,env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=30)
    def test_exact_branch_commit_wins_over_unchanged_master(self):
        r=self.resolve(self.target)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(r.stdout.strip(),self.target)
        self.assertEqual(self.git('-C',str(self.work),'rev-parse','HEAD'),self.initial)
        self.assertEqual(self.git('-C',str(self.work),'rev-parse','origin/master'),self.initial)
    def test_default_still_uses_master(self):
        r=self.resolve()
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(r.stdout.strip(),self.initial)
    def test_short_or_shell_like_target_is_rejected(self):
        for target in [self.target[:12],'; touch NOT_ALLOWED','--upload-pack=invalid']:
            with self.subTest(target=target):
                self.assertNotEqual(self.resolve(target).returncode,0)
        self.assertFalse((self.work/'NOT_ALLOWED').exists())
    def test_absent_commit_is_rejected(self):
        self.assertNotEqual(self.resolve('0'*40).returncode,0)
    def test_non_fast_forward_commit_is_rejected(self):
        self.git('-C',str(self.seed),'checkout','--orphan','unrelated')
        unrelated=self.commit('unrelated')
        self.git('-C',str(self.seed),'push','origin','unrelated')
        self.assertNotEqual(self.resolve(unrelated).returncode,0)

if __name__=='__main__':unittest.main()
