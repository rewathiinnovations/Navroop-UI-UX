import { afterEach } from 'vitest';
import './data-dir-guard';
import { revokeLocalhost } from './network-guard';

afterEach(() => {
  revokeLocalhost();
});
