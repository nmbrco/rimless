import get from "lodash.get";
import set from "lodash.set";
import { v4 as uuidv4 } from "uuid";

import { isTrustedRemote, isWorker } from "./helpers";
import {
  actions,
  events,
  IRPCRequestPayload,
  IRPCResolvePayload,
  ISchema,
} from "./types";

type MessageReceiver =
  | Worker
  | {
      addEventListener: (
        type: "message",
        handler: (event: MessageEvent) => void | Promise<void>
      ) => void;
      removeEventListener: (
        type: "message",
        handler: (event: MessageEvent) => void | Promise<void>
      ) => void;
      postMessage?: never;
    };

/**
 * for each function in the schema
 * 1. subscribe to an event that the remote can call
 * 2. listen for calls from the remote. When called execute the function and emit the results.
 *
 * @param methods an array of method ids from the local schema
 * @param _connectionID
 * @return a function to cancel all subscriptions
 */
export function registerLocalMethods(
  schema: ISchema = {},
  methods: any[] = [],
  _connectionID: string,
  messageReceiver?: MessageReceiver
): any {
  const listeners: any[] = [];
  methods.forEach((methodName) => {
    // handle a remote calling a local method
    async function handleCall(event: any) {
      const {
        action,
        callID,
        connectionID,
        callName,
        args = [],
      } = event.data as IRPCRequestPayload;

      if (action !== actions.RPC_REQUEST) return;
      if (!isTrustedRemote(event)) return;
      if (!callID || !callName) return;
      if (callName !== methodName) return;
      if (connectionID !== _connectionID) return;

      const payload: IRPCResolvePayload = {
        action: actions.RPC_RESOLVE,
        callID,
        callName,
        connectionID,
        error: null,
        result: null,
      };

      // run function and return the results to the remote
      try {
        const result = await get(schema, methodName)(...args);
        payload.result = JSON.parse(JSON.stringify(result));
      } catch (error) {
        payload.error = JSON.parse(
          JSON.stringify(error, Object.getOwnPropertyNames(error))
        );
      }

      if (messageReceiver && messageReceiver.postMessage) {
        messageReceiver.postMessage(payload);
      } else if (isWorker()) {
        (self as any).postMessage(payload);
      } else if (event.source.window === event.source) {
        event.source.postMessage(payload, event.origin);
      } else {
        event.source.postMessage(payload);
      }
    }

    // subscribe to the call event
    if (messageReceiver) {
      messageReceiver.addEventListener(events.MESSAGE, handleCall);
      listeners.push(() =>
        messageReceiver.removeEventListener(events.MESSAGE, handleCall)
      );
    } else {
      self.addEventListener(events.MESSAGE, handleCall);
      listeners.push(() =>
        self.removeEventListener(events.MESSAGE, handleCall)
      );
    }
  });

  return () => {
    listeners.forEach((unregister) => unregister());
  };
}

/**
 * Create a function that will make an RPC request to the remote with some arguments.
 * Listen to an event that returns the results from the remote.
 *
 * @param _callName
 * @param _connectionID
 * @param event
 * @param listeners
 * @param messageReceiver
 *
 * @returns a promise with the result of the RPC
 */
export function createRPC(
  _callName: string,
  _connectionID: string,
  event: any,
  listeners: Array<() => void> = [],
  messageReceiver?: MessageReceiver
) {
  return (...args: any) => {
    return new Promise((resolve, reject) => {
      const callID = uuidv4();

      // on RPC response
      function handleResponse(event: any) {
        const {
          callID: responseCallID,
          connectionID,
          callName,
          result,
          error,
          action,
        } = event.data as IRPCResolvePayload;

        if (!isTrustedRemote(event)) return;
        if (!responseCallID || !callName) return;
        if (callName !== _callName) return;
        if (connectionID !== _connectionID) return;
        if (responseCallID !== callID) return;

        // resolve the response
        if (action === actions.RPC_RESOLVE) return resolve(result);
        if (action === actions.RPC_REJECT) return reject(error);
      }

      // send the RPC request with arguments
      const payload = {
        action: actions.RPC_REQUEST,
        args: JSON.parse(JSON.stringify(args)),
        callID,
        callName: _callName,
        connectionID: _connectionID,
      };

      if (messageReceiver) {
        messageReceiver.addEventListener(events.MESSAGE, handleResponse);
        listeners.push(() =>
          messageReceiver.removeEventListener(events.MESSAGE, handleResponse)
        );
      } else {
        self.addEventListener(events.MESSAGE, handleResponse);
        listeners.push(() =>
          self.removeEventListener(events.MESSAGE, handleResponse)
        );
      }

      if (messageReceiver && messageReceiver.postMessage) {
        messageReceiver.postMessage(payload);
      } else if (isWorker()) {
        (self as any).postMessage(payload);
      } else if (event.source && event.source.window === event.source) {
        event.source.postMessage(payload, event.origin);
      } else if (event.source) {
        event.source.postMessage(payload);
      } else {
        // no-op; event source has disappeared and cannot receive the response
      }
    });
  };
}

/**
 * create an object based on the remote schema and methods. Functions in that object will
 * emit an event that will trigger the RPC on the remote.
 *
 * @param schema
 * @param methods
 * @param _connectionID
 * @param event
 * @param messageReceiver
 */
export function registerRemoteMethods(
  schema: ISchema = {},
  methods: any[] = [],
  _connectionID: string,
  event: any,
  messageReceiver?: MessageReceiver
) {
  const remote = { ...schema };
  const listeners: Array<() => void> = [];

  methods.forEach((methodName) => {
    const rpc = createRPC(
      methodName,
      _connectionID,
      event,
      listeners,
      messageReceiver
    );
    set(remote, methodName, rpc);
  });

  return {
    remote,
    unregisterRemote: () => listeners.forEach((unregister) => unregister()),
  };
}
