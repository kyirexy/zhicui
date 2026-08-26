export type NativeUpdateCheckDisposition =
  | 'unsupported'
  | 'reuse'
  | 'hold'
  | 'check';

export function nativeUpdateCheckDisposition(options: {
  packaged: boolean;
  hasInFlightCheck: boolean;
  status: string;
}): NativeUpdateCheckDisposition {
  if (!options.packaged) return 'unsupported';
  if (options.hasInFlightCheck) return 'reuse';
  if (options.status === 'downloading' || options.status === 'downloaded') {
    return 'hold';
  }
  return 'check';
}
