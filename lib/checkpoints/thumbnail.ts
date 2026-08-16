import { sandboxManager } from '@/lib/sandbox/sandbox-manager';

const VIEWPORT = { width: 1280, height: 800 } as const;
const WAIT_MS = 10_000;

function toDataUrl(bytes: Buffer | Uint8Array) {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

async function captureWithPlaywright(previewUrl: string): Promise<string> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(previewUrl, { waitUntil: 'networkidle', timeout: WAIT_MS });
    const buffer = await page.screenshot({ type: 'png' });
    return toDataUrl(buffer);
  } finally {
    await browser.close();
  }
}

async function captureWithE2B(previewUrl: string): Promise<string> {
  const provider =
    sandboxManager.getActiveProvider() ||
    (globalThis as { activeSandboxProvider?: { runCommand?: (cmd: string) => Promise<{ stdout?: string; success?: boolean }> } })
      .activeSandboxProvider;
  const sandbox = (globalThis as { activeSandbox?: { runCode?: (code: string) => Promise<{ logs?: { stdout?: string[] } }> } })
    .activeSandbox;

  const script = `
import base64, os, subprocess, sys
url = ${JSON.stringify(previewUrl)}
out = "/tmp/navroop-ckpt.png"
ok = False
try:
    subprocess.run(
        ["npx", "--yes", "playwright", "screenshot", "--viewport-size=1280,800", url, out],
        check=True,
        timeout=30,
        capture_output=True,
    )
    ok = os.path.exists(out)
except Exception:
    ok = False
if not ok:
    for bin_name in ("chromium", "chromium-browser", "google-chrome"):
        try:
            subprocess.run(
                [bin_name, "--headless", "--disable-gpu", f"--window-size={1280},{800}", f"--screenshot={out}", url],
                check=True,
                timeout=30,
                capture_output=True,
            )
            if os.path.exists(out):
                ok = True
                break
        except Exception:
            continue
if not ok:
    sys.exit(2)
with open(out, "rb") as f:
    print(base64.b64encode(f.read()).decode("ascii"))
`;

  if (sandbox?.runCode) {
    const result = await sandbox.runCode(script);
    const printed = result.logs?.stdout?.join('')?.trim() ?? '';
    if (!printed) throw new Error('E2B screenshot produced no data');
    return `data:image/png;base64,${printed}`;
  }

  if (provider?.runCommand) {
    const result = await provider.runCommand(
      `python3 -c ${JSON.stringify(script)}`,
    );
    const printed = result.stdout?.replace(/^STDOUT:\s*/m, '').trim() ?? '';
    const b64 = printed.split('\n').filter(Boolean).at(-1) ?? '';
    if (!b64) throw new Error('E2B screenshot produced no data');
    return `data:image/png;base64,${b64}`;
  }

  throw new Error('No E2B sandbox available for thumbnail fallback');
}

/** Best-effort PNG data URL. Never throws to the caller. */
export async function captureThumbnail(previewUrl?: string | null): Promise<string | null> {
  if (!previewUrl?.trim()) return null;
  try {
    return await captureWithPlaywright(previewUrl.trim());
  } catch (error) {
    console.warn('[checkpoints] Playwright thumbnail failed, trying E2B fallback', error);
    try {
      return await captureWithE2B(previewUrl.trim());
    } catch (fallbackError) {
      console.warn('[checkpoints] thumbnail capture failed', fallbackError);
      return null;
    }
  }
}
