import grok from './grok.js';
import claude from './claude.js';

export const ADAPTERS = { grok, claude };

export function getAdapter(name) {
  return Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : null;
}
