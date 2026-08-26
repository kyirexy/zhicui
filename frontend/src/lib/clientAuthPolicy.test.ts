import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveClientAuthPolicy,
  shouldDiscardDevelopmentSession,
} from './clientAuthPolicy.ts';

test('anonymous browser keeps the marketing homepage public', () => {
  const policy = resolveClientAuthPolicy('/', {
    desktop: false,
    nativeAndroid: false,
    development: false,
  });
  assert.equal(policy.publicRoute, true);
  assert.equal(policy.browserClientGate, false);
});

test('desktop and Android treat the root route as an authenticated workspace', () => {
  const desktop = resolveClientAuthPolicy('/', {
    desktop: true,
    nativeAndroid: false,
    development: false,
  });
  const android = resolveClientAuthPolicy('/', {
    desktop: false,
    nativeAndroid: true,
    development: false,
  });
  assert.equal(desktop.publicRoute, false);
  assert.equal(desktop.installedClient, true);
  assert.equal(android.publicRoute, false);
  assert.equal(android.installedClient, true);
});

test('production browser workspace routes are directed to client download', () => {
  const policy = resolveClientAuthPolicy('/library/creators', {
    desktop: false,
    nativeAndroid: false,
    development: false,
  });
  assert.equal(policy.clientOnlyRoute, true);
  assert.equal(policy.browserClientGate, true);
});

test('login remains public in every runtime', () => {
  const policy = resolveClientAuthPolicy('/login', {
    desktop: true,
    nativeAndroid: false,
    development: false,
  });
  assert.equal(policy.publicRoute, true);
  assert.equal(policy.browserClientGate, false);
});

test('desktop development discards a legacy implicit dev account by default', () => {
  assert.equal(shouldDiscardDevelopmentSession(
    { email: 'dev@zhicui.local' },
    { desktop: true, development: true, automaticDevAuth: false },
  ), true);
});

test('real accounts and explicitly enabled dev auth remain persistent', () => {
  assert.equal(shouldDiscardDevelopmentSession(
    { email: 'user@example.com' },
    { desktop: true, development: true, automaticDevAuth: false },
  ), false);
  assert.equal(shouldDiscardDevelopmentSession(
    { email: 'dev@zhicui.local' },
    { desktop: true, development: true, automaticDevAuth: true },
  ), false);
  assert.equal(shouldDiscardDevelopmentSession(
    { email: 'dev@zhicui.local' },
    { desktop: true, development: false, automaticDevAuth: false },
  ), false);
});
