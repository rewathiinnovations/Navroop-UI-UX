import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

const INSTANCE_ID = `${hostname()}-${process.pid}-${randomBytes(4).toString('hex')}`;

export function getInstanceId() {
  return INSTANCE_ID;
}
