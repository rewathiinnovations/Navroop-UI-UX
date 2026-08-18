import { SandboxProvider, SandboxProviderConfig } from './types';
import { E2BProvider } from './providers/e2b-provider';
import { ModalProvider } from './providers/modal-provider';
import { DaytonaProvider } from './providers/daytona-provider';
import { decryptProviderSecrets, type StoredProviderConfig } from './store';
import { SANDBOX_DRIVERS, type InjectedSandboxClient, type SandboxDriverId } from './provider';

export class SandboxFactory {
  static create(provider?: string, config?: SandboxProviderConfig): SandboxProvider {
    const selectedProvider = (provider || 'e2b').toLowerCase();

    switch (selectedProvider) {
      case 'e2b':
        return new E2BProvider(config || {});
      case 'modal':
        return new ModalProvider(config?.modal || { tokenId: '', tokenSecret: '' });
      case 'daytona':
        return new DaytonaProvider(config?.daytona || { apiKey: '' });
      default:
        throw new Error(
          `Unknown sandbox provider: ${selectedProvider}. Supported providers: e2b, modal, daytona`,
        );
    }
  }

  static fromRow(row: StoredProviderConfig, options?: { client?: InjectedSandboxClient }): SandboxProvider {
    const secrets = decryptProviderSecrets(row.secrets);
    if (row.driver === 'modal') {
      const modal = secrets as { tokenId?: string; tokenSecret?: string };
      return new ModalProvider(
        { tokenId: modal.tokenId || '', tokenSecret: modal.tokenSecret || '' },
        options,
      );
    }
    if (row.driver === 'daytona') {
      const daytona = secrets as { apiKey?: string; apiUrl?: string };
      return new DaytonaProvider({ apiKey: daytona.apiKey || '', apiUrl: daytona.apiUrl }, options);
    }
    const e2b = secrets as { apiKey?: string };
    return new E2BProvider({ e2b: { apiKey: e2b.apiKey || '' } }, options);
  }

  static getAvailableProviders(): SandboxDriverId[] {
    return [...SANDBOX_DRIVERS];
  }

  static isProviderAvailable(provider: string): boolean {
    return SANDBOX_DRIVERS.includes(provider.toLowerCase() as SandboxDriverId);
  }
}
