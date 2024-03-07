import { extractMethods, isWorker } from "./helpers";
import { registerLocalMethods, registerRemoteMethods } from "./rpc";
import { actions, events, IConnection, ISchema } from "./types";

const REQUEST_INTERVAL = 600;
const TIMEOUT_INTERVAL = 3000;

function connect(
  schema: ISchema = {},
  target: Window | Worker | ServiceWorker = isWorker()
    ? (self as Worker & typeof self)
    : window.parent,
  options: any = {}
): Promise<IConnection> {
  let interval: any = null;
  let connected = false;
  const listeners =
    target instanceof ServiceWorker ? navigator.serviceWorker : self;
  const messageReceiver =
    target instanceof ServiceWorker ? navigator.serviceWorker : undefined;

  return new Promise((resolve, reject) => {
    const localMethods = extractMethods(schema);

    // on handshake response
    function handleHandshakeResponse(event: any) {
      if (event.data.action !== actions.HANDSHAKE_REPLY) return;
      if (target !== event.source) return;

      // register local methods
      const unregisterLocal = registerLocalMethods(
        schema,
        localMethods,
        event.data.connectionID,
        messageReceiver
      );

      // register remote methods
      const { remote, unregisterRemote } = registerRemoteMethods(
        event.data.schema,
        event.data.methods,
        event.data.connectionID,
        event,
        messageReceiver
      );

      // close the connection and all listeners when called
      const close = () => {
        listeners.removeEventListener(events.MESSAGE, handleHandshakeResponse);
        unregisterRemote();
        unregisterLocal();
      };

      connected = true;

      // resolve connection object
      const connection = { remote, close };
      return resolve(connection);
    }

    // subscribe to HANDSHAKE REPLY MESSAGES
    listeners.addEventListener(events.MESSAGE, handleHandshakeResponse);

    const payload = {
      action: actions.HANDSHAKE_REQUEST,
      methods: localMethods,
      schema: JSON.parse(JSON.stringify(schema)),
    };

    interval = setInterval(() => {
      if (connected) return clearInterval(interval);

      // publish the HANDSHAKE REQUEST
      if (target === (target as Window).window) {
        target.postMessage(payload, "*");
      } else {
        target.postMessage(payload);
      }
    }, REQUEST_INTERVAL);

    // timeout the connection after a time
    setTimeout(() => {
      if (!connected) {
        reject("connection timeout");
      }
    }, TIMEOUT_INTERVAL);
  });
}

export default {
  connect,
};
