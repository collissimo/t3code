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
  | { readonly kind: "mark"; readonly t0: number; readonly t1: number; readonly id: string }
  | { readonly kind: "scene"; readonly t0: number; readonly t1: number };

export interface NarrationLine {
  readonly t0: number;
  readonly t1: number;
  /** When the keyframe of this line should be taken. */
  readonly frameT: number;
  readonly text: string;
  readonly actions: ReadonlyArray<NarrationAction>;
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
const budgetFor = (durationMs: number) =>
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

/** The sentences that own a keyframe: every mark, then the strongest actions, then long stretches. */
const chooseFrameOwners = (sentences: ReadonlyArray<Sentence>, durationMs: number) => {
  const budget = budgetFor(durationMs);
  const owners = new Set<number>();
  const ranked = sentences
    .map((sentence, index) => ({ index, score: scoreOf(sentence) }))
    .filter((entry) => entry.score > 0)
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
      if (long && owners.size < budget) {
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
}): Array<NarrationLine> {
  const sentences = splitSentences(input.words);
  const folded = foldActions(input.events, input.marks);
  attach(
    sentences,
    input.sceneChanges === undefined ? folded : withReactions(folded, input.sceneChanges),
  );
  const owners = chooseFrameOwners(sentences, input.durationMs);
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
    const actions = group.flatMap((sentence) => sentence.actions);
    const t0 = group[0]!.t0;
    return {
      t0,
      t1: Math.max(...group.map((sentence) => sentence.t1)),
      frameT: frameTimeOf(t0, actions, input.durationMs),
      text: group.flatMap((sentence) => sentence.words).join(" "),
      actions,
    };
  });
}

const formatClock = (ms: number) => {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const describeActions = (actions: ReadonlyArray<NarrationAction>) => {
  let marks = 0;
  let clicks = 0;
  let pointed = 0;
  let scrolled = false;
  const drags = new Set<string>();
  for (const action of actions) {
    if (action.kind === "mark") marks++;
    else if (action.kind === "clicks") {
      if (action.changed === false) pointed += action.count;
      else clicks += action.count;
    } else if (action.kind === "scroll") scrolled = true;
    else if (action.kind === "drag") drags.add(action.direction);
  }
  const counted = (word: string, count: number) => (count > 1 ? `${word} ×${count}` : word);
  return [
    marks > 0 ? counted("marked", marks) : null,
    clicks > 0 ? counted("clicked", clicks) : null,
    pointed > 0 ? counted("pointed", pointed) : null,
    ...[...drags].map((direction) => `dragged ${direction}`),
    scrolled ? "scrolled" : null,
  ]
    .filter((part) => part !== null)
    .join(", ");
};

/** `- #2 (0:09) [clicked ×3] “…”`: the shape Scrawl pastes, which agents and skills already read. */
export function formatNarrationLine(line: NarrationLine, index: number): string {
  const head = `- #${index + 1} (${formatClock(line.frameT)})`;
  const actions = describeActions(line.actions);
  if (line.text === "") return `${head} ${actions === "" ? "screen changed" : actions}`;
  return `${head}${actions === "" ? "" : ` [${actions}]`} “${line.text}”`;
}
