export type ProductDestinationId =
  | 'home'
  | 'library'
  | 'extract'
  | 'creators'
  | 'harness'
  | 'knowledge'
  | 'plans';

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
    id: 'harness',
    href: '/harness',
    label: '知萃 AI',
    mobileLabel: 'AI 问答',
    description: '基于视频资料提问和研究',
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

const CREATOR_DESTINATION: ProductDestination = {
  id: 'creators',
  href: '/library/creators',
  label: '博主作品',
  mobileLabel: '博主',
  description: '按博主管理和批量提取作品',
  group: 'knowledge-flow',
};

const SINGLE_LINK_EXTRACT_DESTINATION: ProductDestination = {
  id: 'extract',
  href: '/extract',
  label: '单条解析',
  mobileLabel: '解析',
  description: '粘贴一条链接并提取完整内容',
  group: 'knowledge-flow',
};

/** 桌面端左侧导航容纳独立解析和博主入口；移动端继续保持五个主 Tab。 */
export const DESKTOP_PRODUCT_DESTINATIONS: ProductDestination[] = PRODUCT_DESTINATIONS.flatMap(
  (destination) => (
    destination.id === 'library'
      ? [destination, SINGLE_LINK_EXTRACT_DESTINATION, CREATOR_DESTINATION]
      : [destination]
  ),
);

export function isProductDestinationActive(
  destination: ProductDestinationId,
  pathname: string,
): boolean {
  if (destination === 'home') return pathname === '/';
  if (destination === 'plans') return pathname.startsWith('/plans');
  if (destination === 'extract') return pathname.startsWith('/extract');
  if (destination === 'creators') return pathname.startsWith('/library/creators');
  if (destination === 'library') return pathname.startsWith('/library');
  if (destination === 'harness') return pathname.startsWith('/harness');
  return pathname.startsWith('/notes');
}

export function isDesktopProductDestinationActive(
  destination: ProductDestinationId,
  pathname: string,
): boolean {
  if (destination === 'creators') return pathname.startsWith('/library/creators');
  if (destination === 'library') {
    return pathname.startsWith('/library') && !pathname.startsWith('/library/creators');
  }
  return isProductDestinationActive(destination, pathname);
}
