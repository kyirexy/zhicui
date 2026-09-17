import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DESKTOP_PRODUCT_DESTINATIONS,
  PRODUCT_DESTINATIONS,
  isDesktopProductDestinationActive,
} from './productNavigation.ts';

test('桌面导航把单条解析放在视频资料与博主作品之间', () => {
  const ids = DESKTOP_PRODUCT_DESTINATIONS.map((destination) => destination.id);
  const libraryIndex = ids.indexOf('library');

  assert.ok(libraryIndex >= 0);
  assert.deepEqual(ids.slice(libraryIndex, libraryIndex + 3), [
    'library',
    'extract',
    'creators',
  ]);
  assert.equal(
    DESKTOP_PRODUCT_DESTINATIONS.find((destination) => destination.id === 'extract')?.href,
    '/extract',
  );
});

test('移动端继续保持五个主 Tab 且不加入单条解析', () => {
  assert.equal(PRODUCT_DESTINATIONS.length, 5);
  assert.equal(PRODUCT_DESTINATIONS.some((destination) => destination.id === 'extract'), false);
});

test('单条解析、视频资料和博主作品的桌面选中态互斥', () => {
  assert.equal(isDesktopProductDestinationActive('extract', '/extract'), true);
  assert.equal(isDesktopProductDestinationActive('library', '/extract'), false);
  assert.equal(isDesktopProductDestinationActive('creators', '/extract'), false);

  assert.equal(isDesktopProductDestinationActive('extract', '/library'), false);
  assert.equal(isDesktopProductDestinationActive('library', '/library'), true);
  assert.equal(isDesktopProductDestinationActive('creators', '/library'), false);

  assert.equal(isDesktopProductDestinationActive('extract', '/library/creators'), false);
  assert.equal(isDesktopProductDestinationActive('library', '/library/creators'), false);
  assert.equal(isDesktopProductDestinationActive('creators', '/library/creators'), true);
});

test('创作工坊只在桌面导航出现且排在发布计划之后', () => {
  const desktopIds = DESKTOP_PRODUCT_DESTINATIONS.map((destination) => destination.id);
  const studio = DESKTOP_PRODUCT_DESTINATIONS.find((destination) => destination.id === 'studio');
  assert.ok(studio);
  assert.equal(studio.href, '/studio');
  assert.equal(studio.label, '创作工坊');

  const plansIndex = desktopIds.indexOf('plans');
  const studioIndex = desktopIds.indexOf('studio');
  assert.ok(plansIndex >= 0);
  assert.equal(studioIndex, plansIndex + 1);

  assert.equal(PRODUCT_DESTINATIONS.some((destination) => destination.id === 'studio'), false);
});

test('创作工坊的桌面选中态只认 /studio 前缀', () => {
  assert.equal(isDesktopProductDestinationActive('studio', '/studio'), true);
  assert.equal(isDesktopProductDestinationActive('studio', '/library'), false);
  assert.equal(isDesktopProductDestinationActive('library', '/studio'), false);
  assert.equal(isDesktopProductDestinationActive('plans', '/studio'), false);
});
