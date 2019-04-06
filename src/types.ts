export enum events {
  MESSAGE = "message",
}

export enum actions {
  HANDSHAKE_REQUEST = "ANCHOR/HANDSHAKE_REQUEST",
  HANDSHAKE_REPLY = "ANCHOR/HANDSHAKE_REPLY",
  RPC_REQUEST = "ANCHOR/RPC_REQUEST",
  RPC_RESOLVE = "ANCHOR/RPC_RESOLVE",
  RPC_REJECT = "ANCHOR/RPC_REJECT",
}

export interface ISchema {
  [prop: string]: any;
}

export interface IConnections {
  [connectionID: string]: ISchema
}

export interface IEvent extends EventListener {
  source?: Window,
  origin?: string,
  data?: IHandshakeRequestPayload | IHandshakeConfirmationPayload | IRPCRequestPayload | IRPCResolvePayload,
}

export interface IHandshakeRequestPayload {
  action: actions.HANDSHAKE_REQUEST,
  connectionID?: string,
  schema: ISchema;
}

export interface IHandshakeConfirmationPayload {
  action: actions.HANDSHAKE_REPLY,
  connectionID: string,
  schema: ISchema;
}

export interface IRPCRequestPayload {
  action: actions.RPC_REQUEST,
  args: any[],
  callID: string,
  callName: string,
  connectionID?: string,
}

export interface IRPCResolvePayload {
  action: actions.RPC_RESOLVE | actions.RPC_REJECT,
  result?: any,
  error?: Error,
  callID: string,
  callName: string,
  connectionID: string,
}
