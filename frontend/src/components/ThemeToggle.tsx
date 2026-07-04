'use client';

import { useState, useEffect } from 'react';
import { Sun, Moon } from 'lucide-react';

export default function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('light');

  useEffect(() => {
    const saved = localStorage.getItem('theme') as 'dark' | 'light' | null;
    const initial = saved || 'light';
    setTheme(initial);
    document.documentElement.setAttribute('data-theme', initial);
  }, []);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('theme', next);
    document.documentElement.setAttribute('data-theme', next);
  };

  return (
    <button
      onClick={toggleTheme}
      className="relative p-2.5 cursor-pointer rounded-xl bg-white/[0.04] border border-white/[0.06] hover:bg-white/[0.08] hover:border-white/[0.1] transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] min-w-[40px] min-h-[40px] flex items-center justify-center"
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      title={theme === 'dark' ? '切换到亮色模式' : '切换到暗色模式'}
    >
      <span className="transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:rotate-12">
        {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
      </span>
    </button>
  );
}
