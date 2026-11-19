import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSettings from "../serverSettings.ts";
import {
  SimService,
  SimServiceError,
  classifyHarnessPath,
  resolveSimPaths,
  type SimResolvedPaths,
  type SimSettingsConfig,
} from "./SimContracts.ts";
import * as SimStore from "./SimStore.ts";

const RECENT_RUNS_LIMIT = 256;
const REVIEW_TELEMETRY_DEFAULT_WINDOW_MS = 7 * 86_400_000;

const isSimServiceError = Schema.is(SimServiceError);

const toSimError = (cause: unknown): SimServiceError =>
  isSimServiceError(cause)
    ? cause
    : new SimServiceError({
        code: "io",
        problems: [cause instanceof Error ? cause.message : String(cause)],
      });

const attempt = <A>(work: () => A) => Effect.try({ try: work, catch: toSimError });

const recentKey = (threadId: string, runId: string | undefined) =>
  `${threadId}\u0000${runId ?? ""}`;
const threadCaller = (threadId: string, workspaceRoot?: string) => ({
  sessionId: `t3:${threadId}`,
  ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
});

const make = Effect.gen(function* () {
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const writes = yield* Semaphore.make(1);
  const recent = new Map<string, Set<string>>();

  const simSettings: Effect.Effect<SimSettingsConfig, SimServiceError> =
    serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.sim),
      Effect.mapError(toSimError),
    );
  const pathsOf = (sim: SimSettingsConfig) => resolveSimPaths(sim);
  const enabledSettings = simSettings.pipe(
    Effect.filterOrFail(
      (sim) => sim.enabled,
      () => new SimServiceError({ code: "disabled", problems: ["SIM is turned off in settings"] }),
    ),
  );

  /** sim.lock across processes (sim.mjs, sim-gate), polled without blocking the event loop. */
  const acquireFileLock = Effect.fn("SimService.acquireFileLock")(function* (
    paths: SimResolvedPaths,
  ) {
    const deadline = (yield* Clock.currentTimeMillis) + SimStore.SIM_LOCK_WAIT_MS;
    while (!(yield* attempt(() => SimStore.tryLock(paths)))) {
      if ((yield* Clock.currentTimeMillis) > deadline) {
        return yield* new SimServiceError({
          code: "io",
          problems: ["another process holds the SIM lock; try again"],
        });
      }
      yield* Effect.sleep(SimStore.SIM_LOCK_POLL_MS);
    }
  });
  const locked = <A, E, R>(paths: SimResolvedPaths, effect: Effect.Effect<A, E, R>) =>
    writes.withPermits(1)(
      Effect.acquireUseRelease(
        acquireFileLock(paths),
        () => effect,
        () => Effect.sync(() => SimStore.unlock(paths)),
      ),
    );

  const loadForRead = (paths: SimResolvedPaths) => attempt(() => SimStore.loadReadOnly(paths));

  const recordRecent = (
    threadId: string,
    runId: string | undefined,
    files: ReadonlyArray<string>,
  ) => {
    const key = recentKey(threadId, runId);
    const set = recent.get(key) ?? new Set<string>();
    recent.delete(key);
    for (const file of files) set.add(file);
    recent.set(key, set);
    while (recent.size > RECENT_RUNS_LIMIT) {
      const oldest = recent.keys().next().value;
      if (oldest === undefined) break;
      recent.delete(oldest);
    }
  };

  return SimService.of({
    read: Effect.fn("SimService.read")(function* (caller, request) {
      const sim = yield* enabledSettings;
      const paths = pathsOf(sim);
      const loaded = yield* loadForRead(paths);
      const telemetry =
        request.action === "review"
          ? SimStore.readTelemetry(
              paths,
              SimStore.readAuditWatermarkMs(paths) ??
                (yield* Clock.currentTimeMillis) - REVIEW_TELEMETRY_DEFAULT_WINDOW_MS,
            )
          : [];
      return yield* attempt(() =>
        SimStore.runRead({ paths, loaded, caller, settings: sim, telemetry }, request),
      );
    }),

    write: Effect.fn("SimService.write")(function* (caller, request) {
      const paths = pathsOf(yield* enabledSettings);
      return yield* locked(
        paths,
        attempt(() => SimStore.runWrite(paths, caller, request)),
      );
    }),

    applyHarnessChange: Effect.fn("SimService.applyHarnessChange")(function* (caller, request) {
      const paths = pathsOf(yield* enabledSettings);
      const allowTmp = SimStore.isTestSimDir(paths);
      const run = attempt(() =>
        SimStore.runApplyHarnessChange(paths, caller, request, {
          classify: (absolute) =>
            classifyHarnessPath(absolute, paths, caller.workspaceRoot, { allowTmp }),
        }),
      );
      // A dry run writes nothing, so it needs no lock; a live apply holds it across file edit and journal append.
      const outcome = yield* request.dryRun === true ? run : locked(paths, run);
      if (!outcome.result.dryRun && caller.threadId) {
        recordRecent(caller.threadId, caller.activeRunId, outcome.recordedFiles);
      }
      return outcome.result;
    }),

    resetThreadSeenEpoch: Effect.fn("SimService.resetThreadSeenEpoch")(
      function* (threadId: ThreadId, extraSessionIds?: ReadonlyArray<string>) {
        const paths = pathsOf(yield* simSettings);
        return yield* writes.withPermits(1)(
          attempt(() => SimStore.resetThreadSeenEpoch(paths, threadId, extraSessionIds)),
        );
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("SIM seen epoch reset failed", cause).pipe(Effect.as(0)),
      ),
    ),

    trackProviderThread: Effect.fn("SimService.trackProviderThread")(
      function* ({ threadId, providerThreadId, extraSessionIds }) {
        const paths = pathsOf(yield* simSettings);
        return yield* writes.withPermits(1)(
          attempt(() =>
            SimStore.trackProviderThread(paths, threadId, providerThreadId, extraSessionIds),
          ),
        );
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("SIM provider thread epoch tracking failed", cause).pipe(
          Effect.as(false),
        ),
      ),
    ),

    getThreadSeenEpoch: Effect.fn("SimService.getThreadSeenEpoch")(
      function* (threadId) {
        const paths = pathsOf(yield* simSettings);
        return SimStore.getThreadSeenEpoch(paths, threadId);
      },
      Effect.orElseSucceed(() => 0),
    ),

    recordTelemetry: Effect.fn("SimService.recordTelemetry")(
      function* (event) {
        const sim = yield* simSettings;
        if (!sim.enabled) return;
        yield* writes.withPermits(1)(attempt(() => SimStore.appendTelemetry(pathsOf(sim), event)));
      },
      Effect.catchCause((cause) => Effect.logWarning("SIM telemetry failed", cause)),
    ),

    readTelemetry: Effect.fn("SimService.readTelemetry")(
      function* (sinceMs) {
        const paths = pathsOf(yield* simSettings);
        return SimStore.readTelemetry(paths, sinceMs);
      },
      Effect.orElseSucceed(() => []),
    ),

    recordRecentAttemptInTurn: Effect.fn("SimService.recordRecentAttemptInTurn")(
      function* ({ threadId, runId, workspaceRoot, files }) {
        const paths = pathsOf(yield* simSettings);
        recordRecent(
          threadId,
          runId,
          files.map((file) =>
            SimStore.resolveCallerFile(file, threadCaller(threadId, workspaceRoot), paths),
          ),
        );
      },
      Effect.orElseSucceed(() => undefined),
    ),

    hasRecentAttemptForFile: Effect.fn("SimService.hasRecentAttemptForFile")(
      function* ({ threadId, runId, workspaceRoot, file }) {
        const paths = pathsOf(yield* simSettings);
        const wanted = SimStore.resolveCallerFile(
          file,
          threadCaller(threadId, workspaceRoot),
          paths,
        );
        if (runId !== undefined)
          return recent.get(recentKey(threadId, runId))?.has(wanted) ?? false;
        for (const [key, files] of recent) {
          if (key.split("\u0000")[0] === threadId && files.has(wanted)) return true;
        }
        return false;
      },
      Effect.orElseSucceed(() => false),
    ),

    getStateSnapshot: Effect.fn("SimService.getStateSnapshot")(
      function* () {
        const sim = yield* simSettings;
        if (!sim.enabled) return null;
        const paths = pathsOf(sim);
        const loaded = yield* loadForRead(paths);
        return { state: loaded.state, broken: loaded.journal.broken, paths };
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("SIM snapshot failed", cause).pipe(Effect.as(null)),
      ),
    ),

    getObservedModels: Effect.fn("SimService.getObservedModels")(
      function* () {
        const loaded = yield* loadForRead(pathsOf(yield* simSettings));
        return SimStore.observedModels(loaded.state) as ReadonlySet<string>;
      },
      Effect.orElseSucceed((): ReadonlySet<string> => new Set<string>()),
    ),

    resolvePaths: Effect.fn("SimService.resolvePaths")(
      function* () {
        return pathsOf(yield* simSettings);
      },
      Effect.orElseSucceed(() => resolveSimPaths()),
    ),

    findAttemptAuthorSessions: Effect.fn("SimService.findAttemptAuthorSessions")(
      function* (attemptId) {
        const loaded = yield* loadForRead(pathsOf(yield* simSettings));
        return SimStore.attemptAuthorSessions(loaded.state, attemptId) as ReadonlyArray<string>;
      },
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    ),
  });
});

export const layer = Layer.effect(SimService, make);
