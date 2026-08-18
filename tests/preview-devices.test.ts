/**
 * Preview device scale, rotate, persist, and mobile-finding helpers.
 * Run: pnpm exec tsx tests/preview-devices.test.ts
 */
import {
  PREVIEW_DEVICES,
  formatPreviewScale,
  formatPreviewSize,
  isMobilePreviewFinding,
  parseStoredPreviewDevice,
  popupFeaturesForDevice,
  previewScale,
  rotateDeviceSize,
} from '../lib/preview/devices.ts';

let failed = 0;
let passed = 0;

function assert(cond: unknown, name: string) {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${name}`);
}

const byKey = Object.fromEntries(PREVIEW_DEVICES.map((device) => [device.key, device]));

assert(byKey.mobile?.width === 390 && byKey.mobile?.height === 844, 'mobile is iPhone 14/15 logical');
assert(byKey.tablet?.width === 820 && byKey.tablet?.height === 1180, 'tablet is iPad Air logical');
assert(byKey.desktop?.width == null && byKey.desktop?.height == null, 'desktop fills available area');

assert(previewScale(400, 390) === 1, 'does not scale when panel is wider than device');
assert(previewScale(390, 390) === 1, 'does not scale when panel equals device width');
assert(previewScale(292.5, 390) === 0.75, 'scales to 75% when panel is 292.5 and device is 390');
assert(previewScale(195, 390) === 0.5, 'scales to 50% when panel is half the device width');
assert(previewScale(0, 390) === 1, 'zero available width stays unscaled');
assert(previewScale(800, null) === 1, 'desktop (null width) never scales');

assert(formatPreviewScale(0.75) === '75%', 'formats 0.75 as 75%');
assert(formatPreviewScale(1) === null, 'hides percentage when unscaled');
assert(formatPreviewScale(0.333) === '33%', 'rounds 0.333 to 33%');

assert(rotateDeviceSize(390, 844).width === 844 && rotateDeviceSize(390, 844).height === 390, 'rotate swaps mobile w/h');
assert(rotateDeviceSize(820, 1180).width === 1180 && rotateDeviceSize(820, 1180).height === 820, 'rotate swaps tablet w/h');

assert(formatPreviewSize(390, 844) === '390 × 844', 'formats pixel label');
assert(formatPreviewSize(844, 390) === '844 × 390', 'formats rotated pixel label');

assert(parseStoredPreviewDevice(null).key === 'desktop' && parseStoredPreviewDevice(null).rotated === false, 'missing storage defaults to desktop');
assert(parseStoredPreviewDevice('mobile').key === 'mobile', 'plain key string is accepted');
assert(parseStoredPreviewDevice(JSON.stringify({ key: 'tablet', rotated: true })).rotated === true, 'JSON stores rotate');
assert(parseStoredPreviewDevice('nope').key === 'desktop', 'invalid key falls back to desktop');
assert(parseStoredPreviewDevice('{').key === 'desktop', 'broken JSON falls back to desktop');

assert(isMobilePreviewFinding({ detail: 'Button name is missing (390px, button).' }), '390px a11y finding is mobile');
assert(isMobilePreviewFinding({ title: 'Tap targets too small on mobile' }), 'mobile in title is mobile');
assert(!isMobilePreviewFinding({ detail: 'Color contrast (desktop, .hero).' }), 'desktop-only finding is not mobile');
assert(!isMobilePreviewFinding({ title: 'Unused dependency', detail: 'lodash is unused' }), 'generic finding is not mobile');

const features = popupFeaturesForDevice(390, 844);
assert(features.includes('width=390') && features.includes('height=844'), 'popup features use device pixels');

if (failed > 0) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
