import type { ReactNode } from 'react';

const ADMIN_SECTIONS = [
  'dashboard',
  'users',
  'feedback',
  'showcase-cases',
  'notes',
  'plans',
  'export',
  'ops',
  'models',
  'llm',
  'asr',
  'observability',
  'settings',
] as const;

export const dynamicParams = false;

export function generateStaticParams() {
  return ADMIN_SECTIONS.map((section) => ({ section }));
}

export default function AdminSectionLayout({ children }: { children: ReactNode }) {
  return children;
}
