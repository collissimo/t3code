// Turns timed words and screen actions into the lines an agent reads. Speech and pointing do not
// run in step: on 160 real clicks the nearest pointing word ("hier", "das") lay anywhere from 3.3 s
// before to 3 s after the click, and 42% of the clicks came in bursts. So a sentence is never cut
// at an action. Whole sentences own a keyframe, and the actions said over them are listed in front.

export interface TimedWord {
  readonly t0: number;
  readonly t1: number;
  readonly text: string;
}

export type CaptureEvent =
  | {
      readonly kind: "click";
      readonly t: number;
      readonly x: number;
      readonly y: number;
      readonly role?: string;
      readonly label?: string;
    }
  | {
      readonly kind: "drag";
      readonly t: number;
      readonly t1: number;
      readonly x0: number;
      readonly y0: number;
      readonly x1: number;
      readonly y1: number;
      readonly label?: string;
    }
  | { readonly kind: "scroll"; readonly t: number; readonly dx?: number; readonly dy?: number }
  | { readonly kind: "key"; readonly t: number; readonly shortcut: string }
  | { readonly kind: "app_change"; readonly t: number; readonly app: string }
  | { readonly kind: "window"; readonly t: number; readonly text: string };

export interface CaptureMark {
  readonly id: string;
  readonly t0: number;
  readonly t1: number;
  readonly shape?: string;
  readonly strokes?: ReadonlyArray<number>;
  /** What it was drawn on, such as `button “Area”`. */
  readonly on?: string;
}

export interface MarkAction {
  readonly kind: "mark";
  readonly t0: number;
  readonly t1: number;
  readonly id: string;
  readonly text: string;
  /** Its place in drawing order, when the keyframe draws several marks. */
  readonly number?: number;
  readonly flag?: boolean;
}

export type NarrationAction =
  | {
      readonly kind: "clicks";
      readonly t0: number;
      readonly t1: number;
      readonly count: number;
      readonly points: ReadonlyArray<readonly [number, number]>;
      /** What each click landed on, in step with `points`, where something names it. */
      readonly targets: ReadonlyArray<string | null>;
      /** False when the screen did not react: the hand was pointing, not operating anything. */
      readonly changed?: boolean;
    }
  | {
      readonly kind: "drag";
      readonly t0: number;
      readonly t1: number;
      readonly direction: string;
      readonly target?: string;
    }
  | {
      readonly kind: "scroll";
      readonly t0: number;
      readonly t1: number;
      readonly directions: ReadonlyArray<string>;
    }
  | MarkAction
  | { readonly kind: "scene"; readonly t0: number; readonly t1: number }
  /** Said at its place in the speech, but never worth an image of its own. */
  | {
      readonly kind: "note";
      readonly t0: number;
      readonly t1: number;
      readonly text: string;
      readonly count: number;
    };

export interface NarrationLine {
  readonly t0: number;
  readonly t1: number;
  /** When the keyframe of this line should be taken. */
  readonly frameT: number;
  readonly text: string;
  readonly actions: ReadonlyArray<NarrationAction>;
  /** Whole sentences, with the marks drawn over each. */
  readonly sentences: ReadonlyArray<{
    readonly text: string;
    readonly marks: ReadonlyArray<MarkAction>;
  }>;
}

interface Sentence {
  t0: number;
  t1: number;
  words: Array<string>;
  actions: Array<NarrationAction>;
}

// Thinking pauses run long and the speech goes on where it stopped, so a pause ends only a finished
// sentence, or an unfinished one when it runs past this.
const ABANDONED_GAP_MS = 5_000;
const MAX_SENTENCE_WORDS = 60;
const BURST_GAP_MS = 1_500;
const REACTION_MS = 1_000;
const SCROLL_GAP_MS = 1_500;
const NOTE_REPEAT_MS = 3_000;
// Scrawl's rule: a drag this short (as a share of the screen) is the hand moving, not an act.
const SHORT_DRAG = 0.15;
const NO_DIRECTION_DRAG = 0.04;
const SCRUBBED = /slider|scroll bar|scrubber|timeline|progress/iu;
// An action in a speech pause goes to the sentence it is nearest to, up to this far away.
const ATTACH_MS = 3_000;
const SETTLE_MS = 300;
// Scrawl's keyframe budget: each image costs a reading model about 1.5k tokens.
const BASE_KEYFRAMES = 6;
export const budgetFor = (durationMs: number) =>
  Math.min(12, BASE_KEYFRAMES + Math.trunc(Math.max(0, durationMs - 20_000) / 20_000));
const COVERAGE_MS = 35_000;
const COVERAGE_WORDS = 100;

const SCORES: Record<NarrationAction["kind"], number> = {
  mark: 100,
  clicks: 60,
  drag: 50,
  scene: 40,
  scroll: 30,
  note: 0,
};

const endsSentence = (word: string) => /[.!?;:]["”’)\]]*$/.test(word);
const endsClause = (word: string) => /,["”’)\]]*$/.test(word);

/** A model that cannot time words still said them: the speech stays whole on one line. */
export const wordsOrWhole = (
  words: ReadonlyArray<TimedWord>,
  text: string,
  durationMs: number,
): ReadonlyArray<TimedWord> =>
  words.length > 0 || text === "" ? words : [{ text, t0: 0, t1: durationMs }];

export function splitSentences(words: ReadonlyArray<TimedWord>): Array<Sentence> {
  const sentences: Array<Sentence> = [];
  let open: Sentence | null = null;
  for (const word of [...words].sort((a, b) => a.t0 - b.t0)) {
    const text = word.text.trim();
    if (text === "") continue;
    if (open !== null && word.t0 - open.t1 >= ABANDONED_GAP_MS) open = null;
    const last = sentences.at(-1);
    // The model also ends sentences that go on: German starts a new one with a capital.
    if (open === null && last !== undefined && word.t0 - last.t1 < ABANDONED_GAP_MS) {
      if (/^\p{Ll}/u.test(text)) open = last;
    }
    if (open === null) {
      open = { t0: word.t0, t1: word.t1, words: [text], actions: [] };
      sentences.push(open);
    } else {
      open.t1 = Math.max(open.t1, word.t1);
      open.words.push(text);
    }
    const tooLong = open.words.length >= MAX_SENTENCE_WORDS && endsClause(text);
    if (endsSentence(text) || tooLong) open = null;
  }
  return sentences;
}

const MARK_VERBS: Record<string, string> = {
  circle: "circled",
  underline: "underlined",
  line: "drew a line",
  arrow: "drew an arrow",
  tap: "tapped",
};

const markText = ({ shape, strokes, on }: CaptureMark) => {
  const verb = (shape === undefined ? undefined : MARK_VERBS[shape]) ?? "marked";
  const named = on === undefined ? verb : `${verb} ${on}`;
  const count = strokes?.length ?? 1;
  return count > 1 ? `${named} (${count} strokes)` : named;
};

const directionOf = (dx: number, dy: number) =>
  Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";

export function foldActions(
  events: ReadonlyArray<CaptureEvent>,
  marks: ReadonlyArray<CaptureMark>,
): Array<NarrationAction> {
  const actions: Array<NarrationAction> = marks.map((mark) => ({
    kind: "mark",
    t0: mark.t0,
    t1: mark.t1,
    id: mark.id,
    text: markText(mark),
    ...(mark.shape === "flag" ? { flag: true } : {}),
  }));
  const bursts: Array<{
    t0: number;
    t1: number;
    count: number;
    points: Array<readonly [number, number]>;
    targets: Array<string | null>;
  }> = [];
  const scrolls: Array<{ t0: number; t1: number; directions: Set<string> }> = [];
  const notes: Array<{ t0: number; t1: number; text: string; count: number }> = [];
  const addNote = (t: number, text: string) => {
    const same = notes.findLast((note) => note.text === text);
    if (same !== undefined && t - same.t1 < NOTE_REPEAT_MS) {
      same.t1 = t;
      same.count++;
    } else {
      notes.push({ t0: t, t1: t, text, count: 1 });
    }
  };
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    if (event.kind === "click") {
      const target = [event.role, event.label].filter(Boolean).join(" ") || null;
      const burst = bursts.at(-1);
      if (burst !== undefined && event.t - burst.t1 <= BURST_GAP_MS) {
        burst.t1 = event.t;
        burst.count++;
        burst.points.push([event.x, event.y]);
        burst.targets.push(target);
      } else {
        bursts.push({
          t0: event.t,
          t1: event.t,
          count: 1,
          points: [[event.x, event.y]],
          targets: [target],
        });
      }
    } else if (event.kind === "scroll") {
      let scroll = scrolls.at(-1);
      if (scroll !== undefined && event.t - scroll.t1 <= SCROLL_GAP_MS) scroll.t1 = event.t;
      else {
        scroll = { t0: event.t, t1: event.t, directions: new Set() };
        scrolls.push(scroll);
      }
      // A wheel turned away from the hand goes up the page, which Windows counts as positive.
      if ((event.dy ?? 0) > 0) scroll.directions.add("up");
      if ((event.dy ?? 0) < 0) scroll.directions.add("down");
      if ((event.dx ?? 0) > 0) scroll.directions.add("right");
      if ((event.dx ?? 0) < 0) scroll.directions.add("left");
    } else if (event.kind === "key") {
      addNote(event.t, `pressed ${event.shortcut}`);
    } else if (event.kind === "app_change") {
      addNote(event.t, `switched to ${event.app}`);
    } else if (event.kind === "window") {
      addNote(event.t, event.text);
    } else {
      const dx = event.x1 - event.x0;
      const dy = event.y1 - event.y0;
      const length = Math.hypot(dx, dy);
      if (length >= SHORT_DRAG || event.label !== undefined) {
        actions.push({
          kind: "drag",
          t0: event.t,
          t1: event.t1,
          direction: length < NO_DIRECTION_DRAG ? "" : directionOf(dx, dy),
          ...(event.label === undefined ? {} : { target: event.label }),
        });
      }
    }
  }
  for (const burst of bursts) actions.push({ kind: "clicks", ...burst });
  for (const scroll of scrolls) {
    actions.push({ kind: "scroll", ...scroll, directions: [...scroll.directions] });
  }
  for (const note of notes) actions.push({ kind: "note", ...note });
  return actions.sort((a, b) => a.t0 - b.t0);
}

const attach = (sentences: Array<Sentence>, actions: ReadonlyArray<NarrationAction>) => {
  for (const action of actions) {
    const at = (action.t0 + action.t1) / 2;
    let best: Sentence | null = null;
    let bestDistance = Infinity;
    for (const sentence of sentences) {
      const distance = Math.max(sentence.t0 - at, at - sentence.t1, 0);
      if (distance < bestDistance) {
        best = sentence;
        bestDistance = distance;
      }
    }
    if (best !== null && bestDistance <= ATTACH_MS) {
      best.actions.push(action);
    } else {
      sentences.push({ t0: action.t0, t1: action.t1, words: [], actions: [action] });
      sentences.sort((a, b) => a.t0 - b.t0);
    }
  }
};

const scoreOf = (sentence: Sentence) =>
  sentence.actions.reduce((best, action) => Math.max(best, SCORES[action.kind]), 0);

/** Sentences inside a group of marks: its keyframe starts earlier and nothing cuts into it. */
const insideMarkGroups = (
  sentences: ReadonlyArray<Sentence>,
  markGroups: ReadonlyArray<ReadonlyArray<string>>,
) => {
  const inside = new Set<number>();
  for (const ids of markGroups) {
    const holding = sentences.flatMap((sentence, index) =>
      sentence.actions.some((action) => action.kind === "mark" && ids.includes(action.id))
        ? [index]
        : [],
    );
    for (let index = (holding[0] ?? 0) + 1; index <= (holding.at(-1) ?? -1); index++) {
      inside.add(index);
    }
  }
  return inside;
};

/**
 * The sentences that own a keyframe: every mark, then long stretches that show something, then the
 * strongest actions. Ordinary actions fill only the base budget; the rest is for marks and coverage.
 */
const chooseFrameOwners = (
  sentences: ReadonlyArray<Sentence>,
  durationMs: number,
  inside: ReadonlySet<number>,
) => {
  const budget = budgetFor(durationMs);
  const owners = new Set<number>();
  const ranked = sentences
    .map((sentence, index) => ({ index, score: scoreOf(sentence) }))
    .filter((entry) => entry.score > 0 && !inside.has(entry.index))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const { index, score } of ranked) {
    if (score >= SCORES.mark) owners.add(index);
  }
  let stretchStart = 0;
  let stretchWords = 0;
  let best = -1;
  for (let index = 0; index < sentences.length; index++) {
    const sentence = sentences[index]!;
    if (owners.has(index)) {
      stretchStart = sentence.t0;
      stretchWords = sentence.words.length;
      best = -1;
      continue;
    }
    stretchWords += sentence.words.length;
    // The latest of equals splits the stretch most evenly.
    const score = scoreOf(sentence);
    if (score > 0 && !inside.has(index) && score >= (best < 0 ? 0 : scoreOf(sentences[best]!))) {
      best = index;
    }
    const long = sentence.t1 - stretchStart > COVERAGE_MS || stretchWords > COVERAGE_WORDS;
    if (long && best >= 0 && owners.size < budget) {
      owners.add(best);
      stretchStart = sentences[best]!.t0;
      stretchWords = sentences.slice(best, index + 1).flatMap((s) => s.words).length;
      best = -1;
    }
  }
  for (const { index } of ranked) {
    if (owners.size >= Math.min(budget, BASE_KEYFRAMES)) break;
    owners.add(index);
  }
  // Speech with nothing on screen still gets one frame to be read against.
  if (owners.size === 0 && sentences.length > 0) owners.add(0);
  return owners;
};

const frameTimeOf = (t0: number, actions: ReadonlyArray<NarrationAction>, durationMs: number) => {
  const marks = actions.filter((action) => action.kind === "mark");
  const moment = marks.at(-1) ?? actions.findLast((action) => SCORES[action.kind] > 0);
  if (moment === undefined) return t0;
  const settle = moment.kind === "mark" ? 0 : SETTLE_MS;
  return Math.min(moment.t1 + settle, durationMs);
};

/** Clicks the screen answered stay clicks; the rest are marked as pointing. */
const withReactions = (
  actions: ReadonlyArray<NarrationAction>,
  sceneChanges: ReadonlyArray<number>,
): Array<NarrationAction> => {
  // The screen answering the wheel is no news of its own, like the screen answering a click.
  const clickTimes = actions.filter(
    (action) => action.kind === "clicks" || action.kind === "scroll",
  );
  const reacted = (action: { readonly t0: number; readonly t1: number }) =>
    sceneChanges.some((t) => t >= action.t0 && t <= action.t1 + REACTION_MS);
  const scenes: Array<NarrationAction> = sceneChanges
    .filter((t) => !clickTimes.some((a) => t >= a.t0 && t <= a.t1 + REACTION_MS))
    .map((t) => ({ kind: "scene", t0: t, t1: t }));
  return [
    ...actions.map((action) =>
      action.kind === "clicks" ? { ...action, changed: reacted(action) } : action,
    ),
    ...scenes,
  ].toSorted((a, b) => a.t0 - b.t0);
};

export function buildNarration(input: {
  readonly words: ReadonlyArray<TimedWord>;
  readonly events: ReadonlyArray<CaptureEvent>;
  readonly marks: ReadonlyArray<CaptureMark>;
  readonly durationMs: number;
  /** When the screen changed; without it clicks are taken at face value. */
  readonly sceneChanges?: ReadonlyArray<number>;
  /** Mark ids that share one keyframe; without it each sentence with a mark has its own. */
  readonly markGroups?: ReadonlyArray<ReadonlyArray<string>>;
}): Array<NarrationLine> {
  const sentences = splitSentences(input.words);
  const folded = foldActions(input.events, input.marks);
  attach(
    sentences,
    input.sceneChanges === undefined ? folded : withReactions(folded, input.sceneChanges),
  );
  // Nothing said, done or changed: the picture is still what the capture shows.
  if (sentences.length === 0) {
    const frameT = input.durationMs / 2;
    return [{ t0: 0, t1: input.durationMs, frameT, text: "", actions: [], sentences: [] }];
  }
  const owners = chooseFrameOwners(
    sentences,
    input.durationMs,
    insideMarkGroups(sentences, input.markGroups ?? []),
  );
  const groups: Array<Array<Sentence>> = [];
  let ownerSeen = false;
  sentences.forEach((sentence, index) => {
    const owner = owners.has(index);
    // Speech ahead of the first keyframe belongs to it.
    if (groups.length === 0 || (owner && ownerSeen)) groups.push([sentence]);
    else groups.at(-1)!.push(sentence);
    ownerSeen ||= owner;
  });
  return groups.map((group) => {
    const drawn = group
      .flatMap((sentence) => sentence.actions)
      .filter((action) => action.kind === "mark")
      .toSorted((a, b) => a.t0 - b.t0);
    const numbered = (action: NarrationAction): NarrationAction =>
      action.kind === "mark" && drawn.length > 1
        ? { ...action, number: drawn.findIndex((mark) => mark.id === action.id) + 1 }
        : action;
    const actions = group.flatMap((sentence) => sentence.actions).map(numbered);
    const t0 = group[0]!.t0;
    return {
      t0,
      t1: Math.max(...group.map((sentence) => sentence.t1)),
      frameT: frameTimeOf(t0, actions, input.durationMs),
      text: group.flatMap((sentence) => sentence.words).join(" "),
      actions,
      sentences: group.map((sentence) => ({
        text: sentence.words.join(" "),
        marks: sentence.actions.map(numbered).filter((action) => action.kind === "mark"),
      })),
    };
  });
}

const formatClock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const dragText = (drag: Extract<NarrationAction, { kind: "drag" }>) => {
  if (drag.target === undefined) return `dragged ${drag.direction}`;
  // A scrub's direction says nothing: the frame shows where it landed.
  if (SCRUBBED.test(drag.target)) return `scrubbed ${drag.target}`;
  return [`dragged ${drag.target}`, drag.direction].filter(Boolean).join(" ");
};

const describeActions = (actions: ReadonlyArray<NarrationAction>) => {
  const marks = new Map<string, number>();
  const clicks = new Map<string, number>();
  const pointed = new Map<string, number>();
  const notes = new Map<string, number>();
  const add = (into: Map<string, number>, text: string, count = 1) =>
    into.set(text, (into.get(text) ?? 0) + count);
  const drags = new Set<string>();
  const directions = new Set<string>();
  let scrolled = false;
  for (const action of actions) {
    if (action.kind === "mark") {
      if (action.flag !== true) add(marks, action.text);
    } else if (action.kind === "clicks") {
      for (const target of action.targets) {
        if (action.changed === false) {
          add(pointed, target === null ? "pointed" : `pointed at ${target}`);
        } else {
          add(clicks, target === null ? "clicked" : `clicked ${target}`);
        }
      }
    } else if (action.kind === "scroll") {
      scrolled = true;
      for (const direction of action.directions) directions.add(direction);
    } else if (action.kind === "drag") drags.add(dragText(action));
    else if (action.kind === "note") add(notes, action.text, action.count);
  }
  const counted = ([text, count]: [string, number]) => (count > 1 ? `${text} ×${count}` : text);
  return [
    ...[...marks].map(counted),
    ...[...clicks].map(counted),
    ...[...pointed].map(counted),
    ...drags,
    scrolled ? ["scrolled", [...directions].join(" and ")].filter(Boolean).join(" ") : null,
    ...[...notes].map(counted),
  ]
    .filter((part) => part !== null)
    .join(", ");
};

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";

const markLabel = (mark: MarkAction) => {
  const number = mark.number === undefined ? "" : (CIRCLED[mark.number - 1] ?? `(${mark.number})`);
  return `✎${number} ${formatClock(mark.t0)} ${mark.text}`;
};

/**
 * Several marks on a keyframe: each starts a line with the whole sentences said from it on, as
 * Scrawl's agent text does, so "this one" reads next to the number. The image only shows ink.
 */
const formatNumberedMarks = (head: string, line: NarrationLine) => {
  const others = describeActions(line.actions.filter((action) => action.kind !== "mark"));
  const lead: Array<string> = [];
  const marked: Array<{ readonly label: string; readonly said: Array<string> }> = [];
  for (const sentence of line.sentences) {
    for (const mark of sentence.marks) marked.push({ label: markLabel(mark), said: [] });
    if (sentence.text !== "") (marked.at(-1)?.said ?? lead).push(sentence.text);
  }
  const quoted = (said: ReadonlyArray<string>) => (said.length > 0 ? ` “${said.join(" ")}”` : "");
  return [
    `${head}${others === "" ? "" : ` [${others}]`}${quoted(lead)}`,
    ...marked.map(({ label, said }) => `  ${label}${quoted(said)}`),
  ].join("\n");
};

/** `- #2 (0:09) [clicked ×3] “…”`: the shape Scrawl pastes, which agents and skills already read. */
export function formatNarrationLine(line: NarrationLine, index: number): string {
  const flagged = line.actions.some((action) => action.kind === "mark" && action.flag === true);
  const head = `- #${index + 1} (${formatClock(line.frameT)})${flagged ? " ⚑" : ""}`;
  const drawn = line.actions.filter((action) => action.kind === "mark" && action.flag !== true);
  if (drawn.length > 1) return formatNumberedMarks(head, line);
  const actions = describeActions(line.actions);
  if (line.text === "") {
    if (flagged && actions === "") return `${head} flagged this moment`;
    const shown = line.actions.length > 0 ? "screen changed" : "nothing said or done";
    return `${head} ${actions === "" ? shown : actions}`;
  }
  return `${head}${actions === "" ? "" : ` [${actions}]`} “${line.text}”`;
}
