const FORWARDED_EVENTS = ['ready', 'qr', 'authenticated', 'disconnected', 'auth_failure', 'error'];

export function createGeneralClientFactory({ createClient } = {}) {
  if (typeof createClient !== 'function') throw new TypeError('createClient is required');

  return {
    create({ generation, eventSink }) {
      const client = createClient({ generation });
      if (!client) throw new Error('createClient must return a client');
      if (typeof client.confirmStopped !== 'function') {
        throw new TypeError('client.confirmStopped is required');
      }
      if (typeof eventSink === 'function' && typeof client.on === 'function') {
        for (const event of FORWARDED_EVENTS) {
          client.on(event, (...args) => eventSink({ event, generation, args }));
        }
      }
      return Object.freeze({
        generation,
        client,
        initialize: () => client.initialize(),
        destroy: () => client.destroy(),
        confirmStopped: () => client.confirmStopped(),
        forceStop: () => typeof client.forceStop === 'function' ? client.forceStop() : false,
      });
    },
  };
}
