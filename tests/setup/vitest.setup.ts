import { afterEach } from 'vitest';
import './data-dir-guard';
import { resetAllowedHosts, revokeLocalhost } from './network-guard';

afterEach(() => {
  revokeLocalhost();
  resetAllowedHosts();
});
