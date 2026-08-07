import assert from 'node:assert/strict';
import { ErrorManager, EventRouter, PluginManager } from '../src/index.js';

const events = new EventRouter<Record<string, unknown>>(
  new ErrorManager(() => {}, () => {}),
);
const calls: string[] = [];
const plugins = new PluginManager({ services: { value: 1 }, events });

plugins.register(
  {
    metadata: { name: 'dependent', dependencies: ['base'] },
    onLoad: () => { calls.push('dependent:load'); },
    onEnable: () => { calls.push('dependent:enable'); },
    onDisable: () => { calls.push('dependent:disable'); },
  },
  {
    metadata: { name: 'base' },
    onLoad: () => { calls.push('base:load'); },
    onEnable: () => { calls.push('base:enable'); },
    onDisable: () => { calls.push('base:disable'); },
  },
);
await plugins.enable();
await plugins.enable();
await plugins.disable();
assert.deepEqual(calls, [
  'base:load', 'dependent:load',
  'base:enable', 'dependent:enable',
  'dependent:disable', 'base:disable',
]);

assert.throws(
  () => new PluginManager({ services: {}, events }).register({ metadata: { name: 'missing', dependencies: ['nope'] } }),
  /missing dependency/,
);
console.log('Plugin checks passed');
