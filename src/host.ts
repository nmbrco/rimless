import { v4 as uuidv4 } from 'uuid';

import { extractMethods, getOriginFromURL, isWorker } from './helpers';
import { registerLocalMethods, registerRemoteMethods } from './rpc';
import { actions, events, IConnection, ISchema } from './types';

type Guest = HTMLIFrameElement | Worker | null;
type MessageHandler = (event: MessageEvent) => void | Promise<void>;
type MessageReceiver = {
  addEventListener: (type: 'message', handler: MessageHandler) => void;
  removeEventListener: (type: 'message', handler: MessageHandler) => void;
};

type ConnectionListener = (
  event: MessageEvent,
  negotiateConnection: (schema: ISchema, event: MessageEvent) => IConnection
) => void | Promise<void>;

const hosts = new Map<
  Window | Worker | ServiceWorkerGlobalScope,
  {
    pendingConnections: number;
    connect: (
      guest: Guest,
      schema: ISchema,
      callback: (connection: IConnection) => void | Promise<void>,
      options?: any
    ) => void;
    disconnect: (connectionId: string) => void;
    stop: () => void;
  }
>();

function isValidTarget(iframe: HTMLIFrameElement, event: MessageEvent) {
  const childURL = iframe.getAttribute('src');
  const childOrigin = getOriginFromURL(childURL);
  const hasProperOrigin = event.origin === childOrigin;
  const hasProperSource = event.source === iframe.contentWindow;

  return hasProperOrigin && hasProperSource;
}

const makeConnectionNegotiator = (
  guest: Guest,
  {
    connections,
    messageReceiver,
  }: {
    connections?: Record<string, IConnection>;
    messageReceiver?: MessageReceiver;
  }
) => {
  const negotiateConnection = (schema: ISchema, event: MessageEvent) => {
    if (!event.source) {
      throw new Error('missing event source');
    }

    const connectionID = uuidv4();
    const worker = guest && isWorker(guest) ? (guest as Worker) : undefined;

    // register local methods
    const localMethods = extractMethods(schema);
    const unregisterLocal = registerLocalMethods(
      schema,
      localMethods,
      connectionID,
      worker ?? messageReceiver
    );

    // register remote methods
    const { remote, unregisterRemote } = registerRemoteMethods(
      event.data.schema,
      event.data.methods,
      connectionID,
      event,
      worker ?? messageReceiver
    );

    const payload = {
      action: actions.HANDSHAKE_REPLY,
      connectionID,
      methods: localMethods,
      schema: JSON.parse(JSON.stringify(schema)),
    };

    // confirm the connection
    if (guest && event.source === (guest as HTMLIFrameElement).contentWindow) {
      event.source.postMessage(payload, '*');
    } else {
      event.source!.postMessage(payload);
    }

    // close the connection and all listeners when called
    const close = () => {
      unregisterRemote();
      unregisterLocal();

      if (connections) {
        delete connections[connectionID];
      }
    };

    // resolve connection object
    const connection: IConnection = {
      remote,
      close,
      clientId:
        event.source !== (event.source as Window).window
          ? (event.source as unknown as Client).id
          : undefined,
    };
    if (connections) {
      connections[connectionID] = connection;
    }

    return connection;
  };

  return negotiateConnection;
};

const findOrCreateHostFor = (
  target: Window | Worker | ServiceWorkerGlobalScope
) => {
  const foundHost = hosts.get(target);

  if (foundHost) {
    return foundHost;
  }

  const connections: Record<string, IConnection> = {};
  const connectionListeners = new Map<Guest, Set<ConnectionListener>>();

  const downstreamReceivers = new Set<MessageHandler>();
  const isTargetServiceWorkerGlobalScope =
    typeof ServiceWorkerGlobalScope !== 'undefined' &&
    target instanceof ServiceWorkerGlobalScope;

  const messageReceiver = isTargetServiceWorkerGlobalScope
    ? {
        addEventListener: (type: 'message', handler: MessageHandler) => {
          if (type !== 'message') {
            return;
          }

          downstreamReceivers.add(handler);
        },
        removeEventListener: (type: 'message', handler: MessageHandler) => {
          if (type !== 'message') {
            return;
          }

          downstreamReceivers.delete(handler);
        },
      }
    : undefined;

  const mainListener = async (event_: Event) => {
    const event = event_ as MessageEvent;

    if (!event.data || !event.source || !event.origin) {
      throw new Error('unknown message type');
    }

    if (event.data.action === actions.HANDSHAKE_REQUEST) {
      for (const [guest, listeners] of connectionListeners) {
        if (
          typeof HTMLIFrameElement !== 'undefined' &&
          guest instanceof HTMLIFrameElement &&
          !isValidTarget(guest, event)
        ) {
          continue;
        }

        const negotiateConnection = makeConnectionNegotiator(guest, {
          connections,
          messageReceiver,
        });

        for (const listener of listeners) {
          listener(event, negotiateConnection);
        }
      }
    } else if (isTargetServiceWorkerGlobalScope) {
      for (const listener of downstreamReceivers) {
        listener(event);
      }
    }
  };

  const host = {
    pendingConnections: 0,
    connect: (
      guest: Guest,
      schema: ISchema,
      callback: (connection: IConnection) => void | Promise<void>
    ) => {
      host.pendingConnections += 1;

      let connectionListenersForGuest = connectionListeners.get(guest);

      if (!connectionListenersForGuest) {
        connectionListenersForGuest = new Set<ConnectionListener>();
        connectionListeners.set(guest, connectionListenersForGuest);
      }

      const listener = (
        event: MessageEvent,
        negotiateConnection: (
          schema: ISchema,
          event: MessageEvent
        ) => IConnection
      ) => {
        const connection = negotiateConnection(schema, event);

        host.pendingConnections = Math.max(host.pendingConnections - 1, 0);
        connectionListenersForGuest!.delete(listener);
        callback(connection);
      };

      connectionListenersForGuest.add(listener);
    },
    disconnect: (connectionId: string) => {
      const connection = connections[connectionId];

      if (connection) {
        connection.close();
      }
    },
    stop: ({ shouldCleanupConnections = true } = {}) => {
      if (shouldCleanupConnections) {
        for (const connection of Object.values(connections)) {
          connection.close();
        }
      }

      target.removeEventListener(events.MESSAGE, mainListener);
      hosts.delete(target);
    },
  };

  hosts.set(target, host);
  target.addEventListener(events.MESSAGE, mainListener);

  return host;
};

/**
 * Perform a handshake with the target iframe, when the handshake is confirmed
 * resolve the connection object containing RPCs and properties
 *
 * @param iframe
 * @param schema
 * @param options
 * @returns Promise
 */
export const connect = async (
  guest: Guest,
  schema: ISchema = {},
  options?: any
) => {
  if (!guest) throw new Error('a target is required');

  const hostTarget = isWorker(guest) ? (guest as Worker) : window;
  const host = findOrCreateHostFor(hostTarget);

  return new Promise<IConnection>((resolve) => {
    const callback = (connection: IConnection) => {
      if (host.pendingConnections === 0) {
        host.stop({ shouldCleanupConnections: false });
      }

      resolve(connection);
    };

    host.connect(guest, schema, callback, options);
  });
};

export function serve(
  hostTarget: Window | Worker | ServiceWorkerGlobalScope,
  schema: ISchema = {},
  options?: any
) {
  const server = findOrCreateHostFor(hostTarget);
  let isStopped = false;

  async function* connectionGenerator() {
    while (!isStopped) {
      yield await new Promise<IConnection>((resolve) => {
        server.connect(null, schema, resolve, options);
      });
    }
  }

  return {
    connections: connectionGenerator(),
    stop: () => {
      isStopped = true;
      server.stop();
    },
  };
}

export default {
  connect,
  serve,
};
