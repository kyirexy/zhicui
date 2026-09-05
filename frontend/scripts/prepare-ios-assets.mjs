import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../public/logo.png', import.meta.url));
const assets = new URL('../ios/App/App/Assets.xcassets/', import.meta.url);
// 将已有品牌资源编译成苹果要求的尺寸，避免模板图标进入安装包。
await sharp(source).resize(1024, 1024, { fit: 'contain', background: '#ffffff' })
  .flatten({ background: '#ffffff' }).png()
  .toFile(fileURLToPath(new URL('AppIcon.appiconset/AppIcon-512@2x.png', assets)));
const mark = await sharp(source).resize(320, 320, { fit: 'contain', background: '#ffffff' })
  .flatten({ background: '#ffffff' }).png().toBuffer();
for (const filename of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  await sharp({ create: { width: 2732, height: 2732, channels: 3, background: '#ffffff' } })
    .composite([{ input: mark, gravity: 'centre' }]).png()
    .toFile(fileURLToPath(new URL(`Splash.imageset/${filename}`, assets)));
}
