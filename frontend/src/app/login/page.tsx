'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/hooks/AuthContext';
import { Mail, Lock, ArrowRight } from 'lucide-react';

export default function LoginPage() {
  const { login, register, error, clearError } = useAuth();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [submitting, setSubmitting] = useState(false);
  const [fieldError, setFieldError] = useState('');

  const validate = () => {
    if (!email.includes('@')) return '请输入有效的邮箱地址';
    if (password.length < 6) return '密码至少需要 6 位字符';
    return '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();
    const ve = validate();
    if (ve) { setFieldError(ve); return; }
    setFieldError('');

    setSubmitting(true);
    const ok = mode === 'login'
      ? await login(email, password)
      : await register(email, password);
    setSubmitting(false);

    if (ok) {
      const params = new URLSearchParams(window.location.search);
      const redirect = params.get('redirect') || '/';
      router.push(redirect);
    }
  };

  return (
    <div className="min-h-[70vh] flex items-center justify-center px-5">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <img src="/logo.png" alt="知萃" className="h-12 w-12 mx-auto mb-3 object-contain" />
          <h1 className="text-xl font-bold text-foreground">
            {mode === 'login' ? '欢迎回来' : '创建账号'}
          </h1>
          <p className="text-xs text-foreground-muted mt-1">
            {mode === 'login' ? '登录后查看你的知识卡片' : '注册后开始萃取视频知识'}
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <Mail size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground-muted" />
            <input
              type="email"
              value={email}
              onChange={e => { setEmail(e.target.value); setFieldError(''); clearError(); }}
              placeholder="邮箱地址"
              className="w-full pl-10 pr-4 py-3 rounded-xl bg-card-bg border border-card-border text-foreground text-sm placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-emerald/50 transition-colors"
              autoComplete="email"
            />
          </div>

          <div className="relative">
            <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-foreground-muted" />
            <input
              type="password"
              value={password}
              onChange={e => { setPassword(e.target.value); setFieldError(''); clearError(); }}
              placeholder="密码（至少6位）"
              className="w-full pl-10 pr-4 py-3 rounded-xl bg-card-bg border border-card-border text-foreground text-sm placeholder:text-foreground-muted/50 focus:outline-none focus:border-accent-emerald/50 transition-colors"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </div>

          {(fieldError || error) && (
            <p className="text-xs text-accent-rose bg-accent-rose/5 rounded-lg px-3 py-2">
              {fieldError || error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-accent-emerald text-white font-semibold text-sm hover:bg-accent-emerald/90 disabled:opacity-50 transition-all"
          >
            {submitting
              ? '处理中…'
              : mode === 'login'
                ? <>登录 <ArrowRight size={16} /></>
                : <>注册 <ArrowRight size={16} /></>
            }
          </button>
        </form>

        {/* Toggle */}
        <p className="mt-6 text-center text-xs text-foreground-muted">
          {mode === 'login' ? '还没有账号？' : '已有账号？'}
          <button
            type="button"
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); clearError(); setFieldError(''); }}
            className="ml-1 text-accent-emerald font-medium hover:underline"
          >
            {mode === 'login' ? '立即注册' : '去登录'}
          </button>
        </p>
      </div>
    </div>
  );
}
