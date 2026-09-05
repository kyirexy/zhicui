export type HomeChannelPlatform = 'douyin' | 'bilibili';
export type HomeChannelMode = 'collect' | 'like' | 'post' | 'import';

const PLATFORM_MODE_ORDER: Record<HomeChannelPlatform, readonly HomeChannelMode[]> = {
  douyin: ['collect', 'like', 'post'],
  bilibili: ['collect', 'like', 'import'],
};

/**
 * 首页只展示服务端明确记录的来源，不能把 unknown 或缺失值猜成“作品”。
 */
export function classifyHomeSourceModes(
  platform: HomeChannelPlatform,
  sourceMode: unknown,
  sourceModes: unknown = [],
): HomeChannelMode[] {
  const candidates = [
    ...(Array.isArray(sourceModes) ? sourceModes : []),
    sourceMode,
  ];
  const allowed = new Set(PLATFORM_MODE_ORDER[platform]);
  return Array.from(new Set(candidates.filter(
    (value): value is HomeChannelMode => (
      typeof value === 'string' && allowed.has(value as HomeChannelMode)
    ),
  )));
}

export function firstPopulatedHomeMode(
  platform: HomeChannelPlatform,
  totals: Partial<Record<HomeChannelMode, number | null | undefined>>,
): HomeChannelMode {
  const order = PLATFORM_MODE_ORDER[platform];
  return order.find((mode) => (totals[mode] || 0) > 0) || order[0];
}
