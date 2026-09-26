#!/usr/bin/env node
// Registers the tsx loader so the TypeScript sources run directly, the way every package here runs.
// The tsconfig is named explicitly: tsx otherwise reads the one in the CWD, and from anywhere but
// this package that means no `jsx: react-jsx` and a "React is not defined" crash at startup.
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });
await import('../src/main.ts');
