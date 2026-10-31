import * as NodeReadline from "node:readline";
import * as NodeVM from "node:vm";

type HostMessage =
  | { readonly type: "start"; readonly code: string }
  | {
      readonly type: "result";
      readonly id: number;
      readonly value?: string;
      readonly error?: string;
    };

interface PendingCall {
  readonly resolve: (json: string) => void;
  readonly reject: (message: string) => void;
}

// Runs inside the context so user code only ever holds this context's objects, never a host function.
const BOOTSTRAP = `(bridge) => {
  // V8's built-in console prints nowhere; a ReferenceError at least tells the program to use text().
  delete globalThis.console;
  const format = (value) => {
    if (typeof value === "string") return value;
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  };
  globalThis.text = (...values) => bridge.text(values.map(format).join(" "));
  globalThis.tools = new Proxy({}, {
    get: (_target, name) =>
      typeof name !== "string" || name === "then"
        ? undefined
        : (input) =>
            new Promise((resolve, reject) =>
              bridge.call(
                name,
                input === undefined ? "{}" : JSON.stringify(input),
                (json) => resolve(json === undefined ? undefined : JSON.parse(json)),
                (message) => reject(new Error(message)),
              ),
            ),
  });
}`;

const describe = (error: unknown) =>
  error instanceof Object && "stack" in error && typeof error.stack === "string"
    ? error.stack
    : String(error);

/**
 * `node:vm` keeps honest programs away from Node, but it is not a security boundary. That is why
 * the tool is limited to full-access threads, whose agent already has a shell, and why this
 * process gets no environment and is killed at the deadline.
 */
export async function runScriptSandboxWorker(): Promise<void> {
  const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const pending = new Map<number, PendingCall>();
  let nextId = 0;
  const code = await new Promise<string>((resolve) => {
    const lines = NodeReadline.createInterface({ input: process.stdin });
    lines.on("line", (line) => {
      const message = JSON.parse(line) as HostMessage;
      if (message.type === "start") {
        resolve(message.code);
        return;
      }
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) call?.reject(message.error);
      else call?.resolve(message.value ?? "null");
    });
    // The host is gone; nothing else would end this process.
    lines.on("close", () => process.exit(0));
  });

  const finish = (error?: unknown) =>
    send(error === undefined ? { type: "done" } : { type: "done", error: describe(error) });
  process.on("unhandledRejection", finish);
  process.on("uncaughtException", finish);

  const context = NodeVM.createContext(Object.create(null) as object, {
    codeGeneration: { strings: false, wasm: false },
  });
  const install = NodeVM.runInContext(BOOTSTRAP, context) as (bridge: unknown) => void;
  install({
    text: (value: string) => send({ type: "text", value }),
    call: (
      tool: string,
      input: string,
      resolve: PendingCall["resolve"],
      reject: PendingCall["reject"],
    ) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ type: "call", id, tool, input });
    },
  });
  try {
    const program = new NodeVM.Script(`(async () => {\n${code}\n})()`, {
      filename: "script.js",
      lineOffset: -1,
    });
    await program.runInContext(context);
    finish();
  } catch (error) {
    finish(error);
  }
}
