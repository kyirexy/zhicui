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
