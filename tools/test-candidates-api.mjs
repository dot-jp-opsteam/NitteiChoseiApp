import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const register = require('../server/candidate-routes');
let handler;
let requestedStaff;
let unavailable = false;
const auth = () => {};
register({
  app: { get(path, middleware, callback) { assert.equal(path, '/api/availability/candidates'); assert.equal(middleware, auth); handler = callback; } },
  requireAuth: auth,
  client: { async execute(query) { requestedStaff = query.args[0]; return { rows: [] }; } },
  readDB: async () => ({ availability: {} }),
  rowToInterview: row => row,
  availabilityApi: { async effectiveAvailability() { if (unavailable) throw Error('Google unavailable'); return { blocks: [] }; } },
});
const tomorrow = new Date(Date.now() + 86400000 + 9 * 3600000).toISOString().slice(0, 10);
async function call(role, query) {
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ authUser: { id: 'own_staff', role }, query }, response);
  return response;
}
assert.equal((await call('intern', { from: tomorrow, to: tomorrow })).statusCode, 403);
assert.equal((await call('staff', { from: tomorrow, to: tomorrow, duration: 'bad' })).statusCode, 400);
const good = await call('staff', { from: tomorrow, to: tomorrow, duration: '30', staffId: 'another_staff' });
assert.equal(good.statusCode, 200);
assert.equal(requestedStaff, 'own_staff');
assert.equal(good.body.slots.length, 30);
assert.ok(!JSON.stringify(good.body).includes('title'));
unavailable = true;
assert.equal((await call('staff', { from: tomorrow, to: tomorrow })).statusCode, 503);
console.log('候補日API：9件成功');
