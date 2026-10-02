'use strict';
/**
 * Makes the Android app icon + splash screen from public/icons/logo.svg.
 * Runs only in the GitHub "Build Android APK" workflow (needs `sharp`, which is
 * installed there and never added to package.json). Output goes to assets/,
 * where `npx @capacitor/assets generate --android` picks it up.
 *
 *   assets/icon-only.png        1024×1024  logo on white (old-style icon)
 *   assets/icon-foreground.png  1024×1024  logo, transparent, inside the safe zone (adaptive icon)
 *   assets/icon-background.png  1024×1024  plain white (adaptive icon background)
 *   assets/splash.png           2732×2732  logo centred on white
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'public', 'icons', 'logo.svg'));
const out = path.join(root, 'assets');
fs.mkdirSync(out, { recursive: true });

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

async function logo(size) {
  return sharp(svg, { density: 600 }).resize(size, size, { fit: 'contain', background: CLEAR }).png().toBuffer();
}

async function canvas(file, size, bg, logoSize) {
  const l = await logo(logoSize);
  const off = Math.round((size - logoSize) / 2);
  await sharp({ create: { width: size, height: size, channels: 4, background: bg } })
    .composite([{ input: l, left: off, top: off }]).png().toFile(path.join(out, file));
  console.log('made', file);
}

(async () => {
  await canvas('icon-only.png', 1024, WHITE, 720);
  await canvas('icon-foreground.png', 1024, CLEAR, 560);   // Android crops adaptive icons to the middle ~66%
  await sharp({ create: { width: 1024, height: 1024, channels: 4, background: WHITE } }).png().toFile(path.join(out, 'icon-background.png'));
  console.log('made icon-background.png');
  await canvas('splash.png', 2732, WHITE, 640);
})().catch((e) => { console.error('Icon generation failed:', e.message); process.exit(1); });
