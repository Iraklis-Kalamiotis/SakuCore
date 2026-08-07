import assert from 'node:assert/strict';
import { definePlugin, ErrorManager, EventRouter, PluginManager } from '../src/index.js';

const events = new EventRouter<{ ping: number }>(new ErrorManager(() => {}, () => {}));
const calls: string[] = [];
const plugins = new PluginManager({ services: { value: 1 }, events });

plugins.register(
  definePlugin({
    metadata: { name: 'dependent', dependencies: ['base'] },
    onLoad: () => { calls.push('dependent:load'); },
    onEnable: () => { calls.push('dependent:enable'); },
    onDisable: () => { calls.push('dependent:disable'); },
    onUnload: () => { calls.push('dependent:unload'); },
  }),
  definePlugin({
    metadata: { name: 'base' },
    onLoad: () => { calls.push('base:load'); },
    onEnable: () => { calls.push('base:enable'); },
    onDisable: () => { calls.push('base:disable'); },
    onUnload: () => { calls.push('base:unload'); },
  }),
);
await plugins.enable();
await plugins.enable();
await plugins.unload();
assert.deepEqual(calls, [
  'base:load', 'dependent:load',
  'base:enable', 'dependent:enable',
  'dependent:disable', 'base:disable',
  'dependent:unload', 'base:unload',
]);

const rollbackCalls: string[] = [];
const rollback = new PluginManager({ services: {}, events });
rollback.register(
  { metadata: { name: 'first' }, onEnable: () => { rollbackCalls.push('first:enable'); }, onDisable: () => { rollbackCalls.push('first:disable'); } },
  { metadata: { name: 'broken', dependencies: ['first'] }, onEnable: () => { throw new Error('enable failed'); } },
);
await assert.rejects(rollback.enable(), /enable failed/);
assert.deepEqual(rollbackCalls, ['first:enable', 'first:disable']);

let pings = 0;
let disposed = 0;
let aborted = false;
const owned = new PluginManager({ services: {}, events });
owned.register({
  metadata: { name: 'owned' },
  onEnable: (ctx) => {
    ctx.events.on('ping', () => { pings++; });
    ctx.cleanup(async () => { disposed++; });
    ctx.signal.addEventListener('abort', () => { aborted = true; });
  },
});
await owned.enable();
events.emit('ping', 1);
await owned.disable();
events.emit('ping', 1);
assert.equal(pings, 1);
assert.equal(disposed, 1);
assert.equal(aborted, true);

assert.throws(
  () => new PluginManager({ services: {}, events }).register({ metadata: { name: 'missing', dependencies: ['nope'] } }),
  /missing dependency/,
);
assert.throws(
  () => new PluginManager({ services: {}, events }).register(
    { metadata: { name: 'a', dependencies: ['b'] } },
    { metadata: { name: 'b', dependencies: ['a'] } },
  ),
  /cycle/,
);
console.log('Plugin checks passed');
