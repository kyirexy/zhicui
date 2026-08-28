export type ClientReleaseChannel = 'beta' | 'stable';

export const CLIENT_RELEASE_CHANNEL: ClientReleaseChannel = (
  process.env.NEXT_PUBLIC_RELEASE_CHANNEL === 'stable' ? 'stable' : 'beta'
);

export function releaseChannelLabel(channel: ClientReleaseChannel): string {
  return channel === 'stable' ? '正式版' : '公测版';
}
