import { promises as dns } from 'node:dns';
import type { DomainDns } from './types';

export const defaultDomainDns: DomainDns = {
  async resolveTxt(name) {
    try {
      return await dns.resolveTxt(name);
    } catch {
      return [];
    }
  },
  async resolve4(name) {
    try {
      return await dns.resolve4(name);
    } catch {
      return [];
    }
  },
  async resolveCname(name) {
    try {
      return await dns.resolveCname(name);
    } catch {
      return [];
    }
  },
};
