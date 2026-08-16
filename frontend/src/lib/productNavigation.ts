export type ProductDestinationId = 'home' | 'library' | 'assistant' | 'knowledge' | 'plans';

export interface ProductDestination {
  id: ProductDestinationId;
  href: string;
  label: string;
  mobileLabel: string;
  description: string;
  group: 'workspace' | 'knowledge-flow';
}

export const PRODUCT_DESTINATIONS: ProductDestination[] = [
  {
    id: 'home',
    href: '/',
    label: '首页',
    mobileLabel: '首页',
    description: '开始或继续处理内容',
    group: 'workspace',
  },
  {
    id: 'library',
    href: '/library',
    label: '视频资料',
    mobileLabel: '视频',
    description: '同步和管理视频',
    group: 'knowledge-flow',
  },
  {
    id: 'assistant',
    href: '/agent',
    label: '视频研伴',
    mobileLabel: '研伴',
    description: '基于视频提问和研究',
    group: 'knowledge-flow',
  },
  {
    id: 'knowledge',
    href: '/notes',
    label: '我的知识',
    mobileLabel: '知识',
    description: '整理长期保留的知识',
    group: 'knowledge-flow',
  },
  {
    id: 'plans',
    href: '/plans',
    label: '行动计划',
    mobileLabel: '计划',
    description: '安排和完成行动',
    group: 'knowledge-flow',
  },
];

export function isProductDestinationActive(
  destination: ProductDestinationId,
  pathname: string,
): boolean {
  if (destination === 'home') return pathname === '/';
  if (destination === 'plans') return pathname.startsWith('/plans');
  if (destination === 'library') return pathname.startsWith('/library');
  if (destination === 'assistant') return pathname.startsWith('/agent');
  return pathname.startsWith('/notes');
}
