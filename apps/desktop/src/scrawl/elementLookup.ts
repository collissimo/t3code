// @effect-diagnostics globalTimers:off -- Lookups are answered at native callback boundaries outside Effect fibers.
// @effect-diagnostics globalDate:off -- A lookup's age is measured on the wall clock.
// @effect-diagnostics nodeBuiltinImport:off -- This desktop-only helper owns a child process.
// What a click or stroke landed on, from UI Automation. COM cannot be called through ffi-rs, so this
// is a PowerShell child, started with the capture: about 80 MB while one runs, no CPU while it waits,
// and a target app that hangs holds up only that child. Only names, control types and automation ids
// are ever read, never a control's value, so nothing typed into a field leaves it.
//
// It compiles a little C# because PowerShell's own System.Windows.Automation stops at coarse panes:
// on the taskbar it found a Pane where IUIAutomation, as Scrawl uses it, finds the Button.
//
// The first lookup in a Chromium-based app turns on that app's accessibility tree, which is the real
// cost of naming things. T3 Code's own windows are skipped to keep it out of this renderer.

import * as NodeChildProcess from "node:child_process";

// A lookup this late describes whatever the click already opened, not what was clicked.
const STALE_MS = 500;
const MAX_CHARS = 60;
const TITLE_MATCH_MIN = 12;

// Vtable order is the contract here: the numbered slots stand for methods this never calls.
const ELEMENT_SCRIPT = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ScrawlElement {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int x; public int y; }
  [ComImport, Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IA { void a0(); void a1(); void a2(); void a3(); E ElementFromPoint(P pt); void a5(); void a6(); void a7(); void a8(); void a9(); void a10(); W ControlViewWalker { get; } }
  [ComImport, Guid("4042c624-389c-4afc-a630-e0c9ee12fe0b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface W { E GetParentElement(E e); }
  [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface E {
    void e0(); void e1(); void e2(); void e3(); void e4(); void e5(); void e6(); void e7(); void e8(); void e9(); void e10(); void e11(); void e12(); void e13(); void e14(); void e15(); void e16();
    int ProcessId { get; } int ControlType { get; }
    [return: MarshalAs(UnmanagedType.BStr)] string Localized();
    [return: MarshalAs(UnmanagedType.BStr)] string Name();
    void e21(); void e22(); void e23(); void e24(); void e25();
    [return: MarshalAs(UnmanagedType.BStr)] string AutomationId();
    void e27();
    [return: MarshalAs(UnmanagedType.BStr)] string HelpText();
    void e29(); void e30(); void e31();
    int IsPassword { get; }
  }
  [ComImport, Guid("ff48dba4-60ef-4201-aa87-54103eef594e")] class C {}
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  static string Q(string name, string value) {
    var o = new StringBuilder(",\"" + name + "\":\"");
    foreach (var c in value ?? "") {
      if (c < 32 || c > 126 || c == '"' || c == '\\') o.Append("\\u").Append(((int)c).ToString("x4"));
      else o.Append(c);
    }
    return o.Append('"').ToString();
  }
  // Text, Image, Group and Custom are usually a piece of a control, which then names them.
  static bool Part(int t) { return t == 50020 || t == 50006 || t == 50026 || t == 50025; }
  static bool Control(int t) { return t == 50000 || t == 50031 || t == 50005 || t == 50011 || t == 50002 || t == 50013 || t == 50019 || t == 50007 || t == 50024 || t == 50029; }
  static string Look(IA a, int x, int y) {
    P p; p.x = x; p.y = y;
    E e = a.ElementFromPoint(p);
    if (Part(e.ControlType)) {
      W w = a.ControlViewWalker;
      E c = e;
      for (int i = 0; i < 2 && c != null; i++) {
        c = w.GetParentElement(c);
        if (c != null && Control(c.ControlType)) { e = c; break; }
      }
    }
    var o = ",\"type\":" + e.ControlType + Q("role", e.Localized());
    if (e.IsPassword != 0) return o;
    return o + Q("name", e.Name()) + Q("help", e.HelpText()) + Q("automationId", e.AutomationId());
  }
  public static void Run() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
    var a = (IA)new C();
    Console.Out.WriteLine("ready");
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      var f = line.Split(' ');
      string o = "";
      try { o = Look(a, (int)double.Parse(f[1]), (int)double.Parse(f[2])); } catch (Exception) {}
      Console.Out.WriteLine("{\"id\":" + f[0] + o + "}");
    }
  }
}
'@
[ScrawlElement]::Run()
`;

export interface ElementHit {
  readonly role: string;
  /** `“Area” #area`, for a click's label. */
  readonly label?: string;
}

export interface ElementAnswer {
  readonly type?: number;
  readonly role?: string;
  readonly name?: string;
  readonly help?: string;
  readonly automationId?: string;
}

const clip = (raw: string | undefined): string | undefined => {
  const text = raw?.split(/\s+/u).filter(Boolean).join(" ");
  if (text === undefined || text === "") return undefined;
  return text.length <= MAX_CHARS
    ? text
    : `${[...text]
        .slice(0, MAX_CHARS - 1)
        .join("")
        .trimEnd()}…`;
};

// UI Automation's control type ids. A control's name is its caption. Everything else can hold what
// the user typed or the window title: a Document's name is the page title, a Pane's or Window's the
// window title, and a Text inside a rich editor is the typed text itself.
const NAMED_TYPES = new Set(
  Object.values({
    Button: 50000,
    CheckBox: 50002,
    Hyperlink: 50005,
    Image: 50006,
    ListItem: 50007,
    List: 50008,
    Menu: 50009,
    MenuBar: 50010,
    MenuItem: 50011,
    ProgressBar: 50012,
    RadioButton: 50013,
    ScrollBar: 50014,
    Slider: 50015,
    Spinner: 50016,
    StatusBar: 50017,
    Tab: 50018,
    TabItem: 50019,
    ToolBar: 50021,
    Tree: 50023,
    TreeItem: 50024,
    Custom: 50025,
    Group: 50026,
    Thumb: 50027,
    DataItem: 50029,
    SplitButton: 50031,
    Header: 50034,
    HeaderItem: 50035,
    Table: 50036,
  }),
);
// Worth saying that a field was clicked, without saying anything about what it holds.
const ROLE_ONLY_TYPES = new Set(Object.values({ ComboBox: 50003, Edit: 50004 }));

/** What may be said about an element, or null when its role and name say nothing. */
export function elementHit(answer: ElementAnswer): ElementHit | null {
  const type = answer.type ?? 0;
  const named = NAMED_TYPES.has(type);
  if (!named && !ROLE_ONLY_TYPES.has(type)) return null;
  const role = clip(answer.role) ?? "element";
  const name = named ? (clip(answer.name) ?? clip(answer.help)) : undefined;
  // Win32 controls number their ids; only a name helps an agent.
  const automationId = /^\d*$/u.test(answer.automationId ?? "")
    ? undefined
    : clip(answer.automationId);
  const parts = [
    name === undefined ? null : `“${name}”`,
    automationId === undefined ? null : `#${automationId}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? { role } : { role, label: parts.join(" ") };
}

/** `button “Area”`, for what a drag moved or a stroke marks. Null when only its role is known. */
export const elementOn = (hit: ElementHit | undefined): string | undefined =>
  hit?.label === undefined ? undefined : `${hit.role} ${hit.label}`;

/** A browser tab is named after its page, which is the window's title. Short names only if equal. */
export function namesWindowTitle(label: string, titles: ReadonlyArray<string>): boolean {
  const name = /“([^”]*)”/u.exec(label)?.[1]?.replace(/…$/u, "").toLowerCase();
  if (name === undefined || name === "") return false;
  return titles.some((raw) => {
    const title = raw.toLowerCase();
    return title === name || (name.length >= TITLE_MATCH_MIN && title.includes(name));
  });
}

interface Job {
  readonly key: string;
  readonly x: number;
  readonly y: number;
  readonly at: number;
}

export interface LookupTransport {
  readonly write: (line: string) => void;
  readonly close: () => void;
}

/** One lookup at a time, none written before the child is ready, none sent once stale. */
export class ElementLookups {
  readonly #transport: LookupTransport;
  readonly #now: () => number;
  readonly #hits = new Map<string, ElementHit>();
  readonly #queue: Array<Job> = [];
  #ready = false;
  #inFlight: { readonly id: number; readonly key: string } | null = null;
  #nextId = 1;
  #onIdle: (() => void) | null = null;

  constructor(transport: LookupTransport, now: () => number = Date.now) {
    this.#transport = transport;
    this.#now = now;
  }

  look(key: string, x: number, y: number): void {
    this.#queue.push({ key, x, y, at: this.#now() });
    this.#pump();
  }

  #pump(): void {
    if (!this.#ready || this.#inFlight !== null) return;
    let job = this.#queue.shift();
    while (job !== undefined && this.#now() - job.at > STALE_MS) job = this.#queue.shift();
    if (job === undefined) {
      this.#onIdle?.();
      return;
    }
    const id = this.#nextId++;
    this.#inFlight = { id, key: job.key };
    this.#transport.write(`${id} ${job.x} ${job.y}\n`);
  }

  answer(line: string): void {
    if (line === "ready") {
      this.#ready = true;
      this.#pump();
      return;
    }
    let parsed: ElementAnswer & { readonly id?: number };
    try {
      parsed = JSON.parse(line) as ElementAnswer & { readonly id?: number };
    } catch {
      return;
    }
    const flight = this.#inFlight;
    if (flight === null || parsed.id !== flight.id) return;
    this.#inFlight = null;
    const hit = elementHit(parsed);
    if (hit !== null) this.#hits.set(flight.key, hit);
    this.#pump();
  }

  /** Waits for a running lookup at most `waitMs`, then ends the child. */
  finish(waitMs: number): Promise<ReadonlyMap<string, ElementHit>> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#onIdle = null;
        this.#transport.close();
        resolve(this.#hits);
      };
      const timer = setTimeout(done, waitMs);
      if (!this.#ready || (this.#inFlight === null && this.#queue.length === 0)) done();
      else this.#onIdle = done;
    });
  }
}

/** Starts the child. On any failure there are simply no names. */
export function startElementLookups(): ElementLookups {
  let child: NodeChildProcess.ChildProcess | null = null;
  const lookups = new ElementLookups({
    write: (line) => {
      child?.stdin?.write(line, () => undefined);
    },
    close: () => {
      child?.kill();
    },
  });
  try {
    child = NodeChildProcess.spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-MTA", "-Command", ELEMENT_SCRIPT],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
  } catch {
    return lookups;
  }
  child.on("error", () => undefined);
  child.stdin?.on("error", () => undefined);
  let pending = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/u);
    pending = lines.pop() ?? "";
    for (const line of lines) lookups.answer(line);
  });
  return lookups;
}
