import assert from 'node:assert/strict';
import { ErrorManager, EventRouter } from '../src/index.js';

interface Events {
  value: number;
  error: unknown;
}

let router: EventRouter<Events>;
const reported: unknown[] = [];
const errors = new ErrorManager(
  (error) => { reported.push(error); },
  (error) => router.emit('error', error),
);
router = new EventRouter(errors, 'error');

let values = 0;
router.once('value', async (value) => { values += value; });
router.emit('value', 2);
router.emit('value', 2);
assert.equal(values, 2);

let errorEvents = 0;
router.on('error', () => {
  errorEvents++;
  throw new Error('error listener failure');
});
router.onGateway('ASYNC_FAILURE', async () => { throw new Error('async failure'); });
router.dispatch('ASYNC_FAILURE', {});
await new Promise((resolve) => setImmediate(resolve));

assert.equal(errorEvents, 1);
assert.equal(reported.length, 2);
console.log('Event router checks passed');
