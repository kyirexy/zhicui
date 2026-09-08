// 原始 imagegen 作品仅做等比缩小和 WebP 压缩，不修改人物。
const fs = require('node:fs');
const path = require('node:path');
const sharp = require(process.env.SHARP_MODULE || '../frontend/node_modules/sharp');
const root = path.resolve(__dirname, '..');
const assets = require('../docs/avatar-prompts-20260908.json');
const out = path.join(root, 'frontend/public/images/avatars/v1');
fs.mkdirSync(out, {recursive:true});
(async () => {
  const tiles = [];
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const target = path.join(out, asset.id + '.webp');
    await sharp(asset.path).resize(256,256,{fit:'contain'}).webp({quality:85}).toFile(target);
    tiles.push({input: await sharp(target).resize(192,192).png().toBuffer(), left:(i%4)*192, top:Math.floor(i/4)*192});
    console.log(asset.id, fs.statSync(target).size);
  }
  fs.mkdirSync(path.join(root,'output'),{recursive:true});
  await sharp({create:{width:768,height:576,channels:3,background:'#eee'}}).composite(tiles).png().toFile(path.join(root,'output/avatar-contact-sheet.png'));
})().catch(error => {console.error(error);process.exit(1)});
