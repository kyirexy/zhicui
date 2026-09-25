import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopMediaCapability, desktopMediaDownloadError } from './desktopMediaDownload.ts';

const origin = 'https://luxai.cn';
const media = '/api/library/douyin/media/123?binding=b&expires=9999999999&signature=s';
test('旧桌面接口只接收本站、当前作品的签名能力地址', () => {
  assert.equal(desktopMediaCapability(media, '123', 'media', origin), origin + media);
  for (const value of [
    'https://v.douyinvod.com/video.mp4', '/api/video/proxy?note_id=n',
    '/api/library/imports/media/123', '/api/notes/n/video/download',
    'zhicui-media://123', '//evil.example' + media, media + '#x',
    '/api/library/douyin/media/123?binding=b', media.replace('/123?', '/456?'),
  ]) assert.equal(desktopMediaCapability(value, '123', 'media', origin), undefined, value);
});
test('普通 CDN 封面不送入签名缓存接口，视频下载不依赖封面', () => {
  assert.equal(desktopMediaCapability('https://p3.douyinpic.com/a.jpg', '123', 'cover', origin), undefined);
  assert.equal(desktopMediaCapability(media.replace('/media/', '/cover/'), '123', 'cover', origin), origin + media.replace('/media/', '/cover/'));
});
test('桌面 IPC 异常以可操作中文呈现，不暴露地址和堆栈', () => {
  assert.equal(desktopMediaDownloadError(new Error("Error invoking remote method 'desktop:download-media': Error: 媒体地址不在可信来源内")), '下载地址已失效，请刷新视频资料后重新下载');
  assert.equal(desktopMediaDownloadError(new Error('HTTP 403')), '请重新验证平台账号后下载');
  assert.equal(desktopMediaDownloadError('Error invoking remote method: https://secret.invalid/?signature=x'), '视频暂时无法下载，请稍后重试');
});
