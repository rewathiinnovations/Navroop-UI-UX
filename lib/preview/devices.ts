export const PREVIEW_DEVICES = [
  { key: 'mobile', label: 'Mobile', width: 390, height: 844, icon: 'smartphone' },
  { key: 'tablet', label: 'Tablet', width: 820, height: 1180, icon: 'tablet' },
  { key: 'desktop', label: 'Desktop', width: null, height: null, icon: 'monitor' },
] as const;

export type PreviewDevice = (typeof PREVIEW_DEVICES)[number];
export type PreviewDeviceKey = PreviewDevice['key'];

export const PREVIEW_DEVICE_STORAGE_KEY = 'navroop.preview.device';
export const PREVIEW_DEVICE_EVENT = 'navroop:preview-device';

export type StoredPreviewDevice = {
  key: PreviewDeviceKey;
  rotated: boolean;
};

export function isPreviewDeviceKey(value: unknown): value is PreviewDeviceKey {
  return value === 'mobile' || value === 'tablet' || value === 'desktop';
}

export function getPreviewDevice(key: PreviewDeviceKey): PreviewDevice {
  return PREVIEW_DEVICES.find((device) => device.key === key) ?? PREVIEW_DEVICES[2];
}

export function previewScale(availableWidth: number, deviceWidth: number | null): number {
  if (deviceWidth == null || deviceWidth <= 0 || availableWidth <= 0) return 1;
  if (availableWidth >= deviceWidth) return 1;
  return availableWidth / deviceWidth;
}

export function formatPreviewScale(scale: number): string | null {
  if (scale >= 1) return null;
  return `${Math.round(scale * 100)}%`;
}

export function rotateDeviceSize(width: number, height: number): { width: number; height: number } {
  return { width: height, height: width };
}

export function formatPreviewSize(width: number, height: number): string {
  return `${Math.round(width)} × ${Math.round(height)}`;
}

export function parseStoredPreviewDevice(raw: string | null | undefined): StoredPreviewDevice {
  const fallback: StoredPreviewDevice = { key: 'desktop', rotated: false };
  if (!raw) return fallback;
  if (isPreviewDeviceKey(raw)) return { key: raw, rotated: false };
  try {
    const parsed = JSON.parse(raw) as { key?: unknown; rotated?: unknown };
    return {
      key: isPreviewDeviceKey(parsed.key) ? parsed.key : 'desktop',
      rotated: parsed.rotated === true && parsed.key !== 'desktop',
    };
  } catch {
    return fallback;
  }
}

export function serializePreviewDevice(value: StoredPreviewDevice): string {
  return JSON.stringify({
    key: value.key,
    rotated: value.key === 'desktop' ? false : value.rotated,
  });
}

export function isMobilePreviewFinding(finding: { id?: string; title?: string; detail?: string }): boolean {
  const text = `${finding.id ?? ''} ${finding.title ?? ''} ${finding.detail ?? ''}`;
  return /\b390px\b|\bmobile\b|\bsmartphone\b/i.test(text);
}

export function popupFeaturesForDevice(width: number, height: number): string {
  return `width=${Math.round(width)},height=${Math.round(height)},noopener,noreferrer`;
}

export function requestPreviewDevice(key: PreviewDeviceKey) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PREVIEW_DEVICE_EVENT, { detail: { key } }));
}

export function openPreviewWindow(url: string, size?: { width: number; height: number } | null) {
  if (!url) return;
  if (!size?.width || !size.height) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  window.open(url, 'navroop-preview-device', popupFeaturesForDevice(size.width, size.height));
}
