"use strict";
(() => {
  function createReconnect(refresh, {now = Date.now, interval = 10000} = {}) {
    let pending = null, next = 0;
    return () => {
      if (pending) return pending;
      if (now() < next) return Promise.resolve(false);
      next = now() + interval;
      pending = Promise.resolve().then(refresh).then(() => true).finally(() => {pending = null;});
      return pending;
    };
  }
  globalThis.UDTH = globalThis.UDTH || {};
  globalThis.UDTH.reconnect = {createReconnect};
  if (typeof module !== 'undefined') module.exports = globalThis.UDTH.reconnect;
})();
