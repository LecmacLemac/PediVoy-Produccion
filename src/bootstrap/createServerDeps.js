import { createDomainDeps } from './createDomainDeps.js';
import { createWppDeps } from './createWppDeps.js';

export function createServerDeps({ projectDir }) {
  return {
    ...createDomainDeps({ projectDir }),
    ...createWppDeps(),
  };
}
