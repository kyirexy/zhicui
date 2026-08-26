const BROWSER_PUBLIC = ['/', '/style'];
const ALWAYS_PUBLIC = ['/login'];
const CLIENT_ONLY_PATHS = [
  '/harness',
  '/extract',
  '/library',
  '/notes',
  '/plans',
  '/process',
  '/settings',
  '/style',
];

export interface ClientAuthPolicy {
  installedClient: boolean;
  publicRoute: boolean;
  clientOnlyRoute: boolean;
  browserClientGate: boolean;
}

export function resolveClientAuthPolicy(
  pathname: string,
  options: {
    desktop: boolean;
    nativeAndroid: boolean;
    development: boolean;
  },
): ClientAuthPolicy {
  const installedClient = options.desktop || options.nativeAndroid;
  const publicRoute = ALWAYS_PUBLIC.includes(pathname)
    || (!installedClient && BROWSER_PUBLIC.includes(pathname));
  const clientOnlyRoute = CLIENT_ONLY_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  return {
    installedClient,
    publicRoute,
    clientOnlyRoute,
    browserClientGate: !options.development
      && clientOnlyRoute
      && !installedClient,
  };
}
