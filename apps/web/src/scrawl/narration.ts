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
  | { readonly kind: "click"; readonly t: number; readonly x: number; readonly y: number }
  | {
      readonly kind: "drag";
      readonly t: number;
      readonly t1: number;
      readonly x0: number;
      readonly y0: number;
      readonly x1: number;
      readonly y1: number;
    }
  | { readonly kind: "scroll"; readonly t: number };

export interface CaptureMark {
  readonly id: string;
  readonly t0: number;
  readonly t1: number;
  readonly shape?: string;
  readonly strokes?: ReadonlyArray<number>;
}

export interface MarkAction {
  readonly kind: "mark";
  readonly t0: number;
  readonly t1: number;
  readonly id: string;
  readonly text: string;
  /** Its place in drawing order, when the keyframe draws several marks. */
  readonly number?: number;
}

export type NarrationAction =
  | {
      readonly kind: "clicks";
      readonly t0: number;
      readonly t1: number;
      readonly count: number;
      readonly points: ReadonlyArray<readonly [number, number]>;
      /** False when the screen did not react: the hand was pointing, not operating anything. */
      readonly changed?: boolean;
    }
  | { readonly kind: "drag"; readonly t0: number; readonly t1: number; readonly direction: string }
  | { readonly kind: "scroll"; readonly t0: number; readonly t1: number }
  | MarkAction
  | { readonly kind: "scene"; readonly t0: number; readonly t1: number };

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
// Scrawl's rule: a drag this short (as a share of the screen) is the hand moving, not an act.
const SHORT_DRAG = 0.15;
// An action in a speech pause goes to the sentence it is nearest to, up to this far away.
const ATTACH_MS = 3_000;
const SETTLE_MS = 300;
// Scrawl's keyframe budget: each image costs a reading model about 1.5k tokens.
export const budgetFor = (durationMs: number) =>
  Math.min(12, 6 + Math.max(0, Math.ceil((durationMs - 40_000) / 20_000)));
const COVERAGE_MS = 35_000;
const COVERAGE_WORDS = 100;

const SCORES: Record<NarrationAction["kind"], number> = {
  mark: 100,
  clicks: 60,
  drag: 50,
  scene: 40,
  scroll: 30,
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

const markText = ({ shape, strokes }: CaptureMark) => {
  const verb = (shape === undefined ? undefined : MARK_VERBS[shape]) ?? "marked";
  const count = strokes?.length ?? 1;
  return count > 1 ? `${verb} (${count} strokes)` : verb;
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
  }));
  const bursts: Array<{
    t0: number;
    t1: number;
    count: number;
    points: Array<readonly [number, number]>;
  }> = [];
  const scrolls: Array<{ t0: number; t1: number }> = [];
  for (const event of [...events].sort((a, b) => a.t - b.t)) {
    if (event.kind === "click") {
      const burst = bursts.at(-1);
      if (burst !== undefined && event.t - burst.t1 <= BURST_GAP_MS) {
        burst.t1 = event.t;
        burst.count++;
        burst.points.push([event.x, event.y]);
      } else {
        bursts.push({ t0: event.t, t1: event.t, count: 1, points: [[event.x, event.y]] });
      }
    } else if (event.kind === "scroll") {
      const scroll = scrolls.at(-1);
      if (scroll !== undefined && event.t - scroll.t1 <= SCROLL_GAP_MS) scroll.t1 = event.t;
      else scrolls.push({ t0: event.t, t1: event.t });
    } else {
      const dx = event.x1 - event.x0;
      const dy = event.y1 - event.y0;
      if (Math.hypot(dx, dy) >= SHORT_DRAG) {
        actions.push({
          kind: "drag",
          t0: event.t,
          t1: event.t1,
          direction: directionOf(dx, dy),
        });
      }
    }
  }
  for (const burst of bursts) actions.push({ kind: "clicks", ...burst });
  for (const scroll of scrolls) actions.push({ kind: "scroll", ...scroll });
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

/** The sentences that own a keyframe: every mark, then the strongest actions, then long stretches. */
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
    if (score >= SCORES.mark || owners.size < budget) owners.add(index);
  }
  if (sentences.length > 0) {
    let stretchStart = 0;
    let stretchWords = 0;
    for (let index = 0; index < sentences.length; index++) {
      const sentence = sentences[index]!;
      if (owners.has(index)) {
        stretchStart = sentence.t0;
        stretchWords = sentence.words.length;
        continue;
      }
      stretchWords += sentence.words.length;
      const long = sentence.t1 - stretchStart > COVERAGE_MS || stretchWords > COVERAGE_WORDS;
      if (long && owners.size < budget && !inside.has(index)) {
        owners.add(index);
        stretchStart = sentence.t0;
        stretchWords = sentence.words.length;
      }
    }
  }
  // Speech with nothing on screen still gets one frame to be read against.
  if (owners.size === 0 && sentences.length > 0) owners.add(0);
  return owners;
};

const frameTimeOf = (t0: number, actions: ReadonlyArray<NarrationAction>, durationMs: number) => {
  const marks = actions.filter((action) => action.kind === "mark");
  const moment = marks.at(-1) ?? actions.at(-1);
  if (moment === undefined) return t0;
  const settle = moment.kind === "mark" ? 0 : SETTLE_MS;
  return Math.min(moment.t1 + settle, durationMs);
};

/** Clicks the screen answered stay clicks; the rest are marked as pointing. */
const withReactions = (
  actions: ReadonlyArray<NarrationAction>,
  sceneChanges: ReadonlyArray<number>,
): Array<NarrationAction> => {
  const clickTimes = actions.filter((action) => action.kind === "clicks");
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

const describeActions = (actions: ReadonlyArray<NarrationAction>) => {
  const marks: Array<string> = [];
  let clicks = 0;
  let pointed = 0;
  let scrolled = false;
  const drags = new Set<string>();
  for (const action of actions) {
    if (action.kind === "mark") marks.push(action.text);
    else if (action.kind === "clicks") {
      if (action.changed === false) pointed += action.count;
      else clicks += action.count;
    } else if (action.kind === "scroll") scrolled = true;
    else if (action.kind === "drag") drags.add(action.direction);
  }
  const counted = (word: string, count: number) => (count > 1 ? `${word} ×${count}` : word);
  return [
    ...marks,
    clicks > 0 ? counted("clicked", clicks) : null,
    pointed > 0 ? counted("pointed", pointed) : null,
    ...[...drags].map((direction) => `dragged ${direction}`),
    scrolled ? "scrolled" : null,
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
  const head = `- #${index + 1} (${formatClock(line.frameT)})`;
  if (line.actions.filter((action) => action.kind === "mark").length > 1) {
    return formatNumberedMarks(head, line);
  }
  const actions = describeActions(line.actions);
  if (line.text === "") {
    const shown = line.actions.length > 0 ? "screen changed" : "nothing said or done";
    return `${head} ${actions === "" ? shown : actions}`;
  }
  return `${head}${actions === "" ? "" : ` [${actions}]`} “${line.text}”`;
}
