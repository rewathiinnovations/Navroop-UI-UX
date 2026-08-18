import type { SandboxProvider } from './types';
import { teardownProvider } from './teardown';

export async function runConformanceSuite(driver: SandboxProvider) {
  const created = await driver.createSandbox();
  const command = await driver.runCommand('echo ok');
  const previewUrl = driver.getSandboxUrl() || created.url || null;
  await teardownProvider(driver);
  return {
    created: Boolean(created?.sandboxId),
    commandOk: command.success || command.exitCode === 0,
    previewUrl,
  };
}
