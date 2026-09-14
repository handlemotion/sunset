import WebSocket from "ws";
import type { WebSocketLike } from "@agentclientprotocol/sdk/experimental/ws-client";

/** Opens the caller-side socket to the engine worker. */
export type CloudSocketOpen = (input: {
  url: string;
  headers: Record<string, string>;
  /** Bound on the socket handshake. */
  timeoutMs?: number;
}) => Promise<WebSocketLike>;

/**
 * Node `ws` socket — it accepts request headers, unlike the browser
 * `WebSocket` constructor, so the bearer token never enters the URL. The
 * open handshake is bounded; a stalled connect rejects instead of hanging.
 */
export const wsSocketOpen: CloudSocketOpen = ({ url, headers, timeoutMs }) =>
  new Promise<WebSocketLike>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("cloud_socket_open_timeout"));
    }, timeoutMs ?? 30_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket as unknown as WebSocketLike);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
