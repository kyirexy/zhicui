export type ProductDestinationId =
  | 'home'
  | 'library'
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
    label: '知萃 Harness',
    mobileLabel: 'Harness',
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

const CREATOR_DESTINATION: ProductDestination = {
  id: 'creators',
  href: '/library/creators',
  label: '博主作品',
  mobileLabel: '博主',
  description: '按博主管理和批量提取作品',
  group: 'knowledge-flow',
};

/** 桌面端左侧导航可容纳独立博主入口；移动端继续保持五个主 Tab。 */
export const DESKTOP_PRODUCT_DESTINATIONS: ProductDestination[] = PRODUCT_DESTINATIONS.flatMap(
  (destination) => (
    destination.id === 'library'
      ? [destination, CREATOR_DESTINATION]
      : [destination]
  ),
);

export function isProductDestinationActive(
  destination: ProductDestinationId,
  pathname: string,
): boolean {
  if (destination === 'home') return pathname === '/';
  if (destination === 'plans') return pathname.startsWith('/plans');
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
