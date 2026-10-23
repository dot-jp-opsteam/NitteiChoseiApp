'use strict';

const staffChains = new Map();

function withStaffLock(staffId, operation) {
  const previous = staffChains.get(staffId) || Promise.resolve();
  const running = previous.then(operation, operation);
  const tail = running.then(() => undefined, () => undefined);
  staffChains.set(staffId, tail);
  tail.then(() => {
    if (staffChains.get(staffId) === tail) staffChains.delete(staffId);
  });
  return running;
}

module.exports = { withStaffLock };
