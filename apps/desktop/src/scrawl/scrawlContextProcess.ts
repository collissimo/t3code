// @effect-diagnostics globalTimers:off -- Helper timeouts run at child-process callback boundaries outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a Node child process.

import * as NodeChildProcess from "node:child_process";

import type {
  ScrawlContextInit,
  ScrawlContextMessage,
  ScrawlContextRequest,
} from "./ScrawlContextWorker.ts";

const STOP_WAIT_MS = 300;

export interface ScrawlContextProcess {
  readonly requestSnapshot: () => void;
  /** Resolves once what the child still held has arrived, or soon after it stopped answering. */
  readonly stop: () => Promise<void>;
  readonly kill: () => void;
}

/** Without it a capture still has its clicks, ink and cursor: this only adds to them. */
export function startScrawlContextProcess(
  workerPath: string,
  init: ScrawlContextInit,
  onMessage: (message: ScrawlContextMessage) => void,
): ScrawlContextProcess {
  let worker: NodeChildProcess.ChildProcess | null = null;
  try {
    worker = NodeChildProcess.fork(workerPath, [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
  } catch {
    worker = null;
  }
  const child = worker;
  const send = (request: ScrawlContextRequest) => {
    if (child?.connected !== true) return;
    child.send(request, () => undefined);
  };
  child?.on("error", () => undefined);
  child?.on("message", (message) => onMessage(message as ScrawlContextMessage));
  send({ type: "init", ...init });

  return {
    requestSnapshot: () => send({ type: "snapshot" }),
    stop: () =>
      new Promise((resolve) => {
        if (child === null || child.exitCode !== null) {
          resolve();
          return;
        }
        const finish = () => {
          clearTimeout(timer);
          child.kill();
          resolve();
        };
        const timer = setTimeout(finish, STOP_WAIT_MS);
        child.on("message", (message) => {
          if ((message as ScrawlContextMessage).type === "stopped") finish();
        });
        child.once("exit", finish);
        send({ type: "stop" });
      }),
    kill: () => {
      child?.kill();
    },
  };
}
