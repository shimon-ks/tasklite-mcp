import { createRequire } from 'node:module';

// Single source of truth: the package.json version, resolved from dist/ at runtime.
export const VERSION: string = createRequire(import.meta.url)('../package.json').version;
