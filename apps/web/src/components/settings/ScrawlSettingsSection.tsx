import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SCRAWL_SHORTCUT,
  SCRAWL_SHORTCUT_STATE_ACTION,
  isModifierPairShortcut,
  type ScrawlCaptureSummary,
  type ScrawlRetention,
  type ScrawlShortcutAvailability,
  type ScrawlShortcutState,
  type SnapShotKeyChord,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import {
  formatSnapShotShortcutLabel,
  sameSnapShotShortcut,
  snapShotKeybindingConflict,
} from "../../lib/snapShotShortcut";
import { isScrawlAvailable } from "../../scrawl/scrawlCapture";
import { formatBytes, setScrawlHistoryOpen } from "../../scrawl/scrawlHistory";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useScrawlCaptures } from "../scrawl/useScrawlCaptures";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SelectButton } from "../ui/select";
import { commandLabel } from "./KeybindingsSettings.logic";
import { SettingsRow, SettingsSection, SettingsUnavailableGroup } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSnapShotShortcutRecorder } from "./useSnapShotShortcutRecorder";

const RETENTION_LABELS: Record<ScrawlRetention, string> = {
  week: "Video 7 days, capture 30",
  month: "Video 30 days, capture 90",
  forever: "Forever",
};

type ShortcutCheck =
  | { readonly status: "idle" }
  | { readonly status: "checking"; readonly shortcut: SnapShotKeyChord }
  | {
      readonly status: "checked";
      readonly shortcut: SnapShotKeyChord;
      readonly availability: ScrawlShortcutAvailability;
    };

/** Follows the desktop app's word on the shortcut: another program can let go of it at any time. */
function useShortcutState() {
  const [state, setState] = useState<ScrawlShortcutState | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop app, which announces when it takes or loses the shortcut
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (bridge?.scrawlGetShortcutState === undefined) return;
    const refresh = () => {
      void bridge.scrawlGetShortcutState?.().then(setState, () => undefined);
    };
    refresh();
    return bridge.onMenuAction((action) => {
      if (action === SCRAWL_SHORTCUT_STATE_ACTION) refresh();
    });
  }, []);
  return state;
}

const overviewText = (captures: ReadonlyArray<ScrawlCaptureSummary>) => {
  if (captures.length === 0) return "Find a capture again, pin it, or see when it goes";
  const bytes = captures.reduce((sum, capture) => sum + capture.sizeBytes, 0);
  const owed = captures.filter((capture) => capture.status === "failed").length;
  const count = captures.length === 1 ? "1 capture" : `${captures.length} captures`;
  return [`${count} using ${formatBytes(bytes)}`, owed > 0 ? `${owed} could not be rebuilt` : null]
    .filter(Boolean)
    .join(", ");
};

export function ScrawlSettingsSection() {
  const saved = useClientSettings((settings) => settings.scrawlShortcut);
  const retention = useClientSettings((settings) => settings.scrawlRetention);
  const snapShotShortcut = useClientSettings((settings) => settings.snapShotShortcut);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutState = useShortcutState();
  const { captures } = useScrawlCaptures();
  const available = isScrawlAvailable();

  const [candidate, setCandidate] = useState<SnapShotKeyChord>(saved);
  const [latestCheck, setCheck] = useState<ShortcutCheck>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const checkIdRef = useRef(0);

  const [renderedSaved, setRenderedSaved] = useState(saved);
  if (!sameSnapShotShortcut(renderedSaved, saved)) {
    setRenderedSaved(saved);
    setCandidate(saved);
    setCheck({ status: "idle" });
  }

  const changed = !sameSnapShotShortcut(candidate, saved);
  const check =
    latestCheck.status !== "idle" && sameSnapShotShortcut(latestCheck.shortcut, candidate)
      ? latestCheck
      : ({ status: "idle" } as const);
  const keybindingConflict = changed ? snapShotKeybindingConflict(candidate, keybindings) : null;
  const usedBySnapShots = changed && sameSnapShotShortcut(candidate, snapShotShortcut);
  const canSave =
    changed &&
    keybindingConflict === null &&
    !usedBySnapShots &&
    check.status === "checked" &&
    check.availability.available;

  const checkShortcut = async (shortcut: SnapShotKeyChord) => {
    const checkId = ++checkIdRef.current;
    setCandidate(shortcut);
    setCheck({ status: "checking", shortcut });
    const availability = await window.desktopBridge?.scrawlCheckShortcut?.(shortcut).catch(() => ({
      available: false,
      message: "Could not check this shortcut",
    }));
    if (availability === undefined || checkId !== checkIdRef.current) return;
    setCheck({ status: "checked", shortcut, availability });
  };

  const reset = () => {
    checkIdRef.current++;
    setCandidate(saved);
    setCheck({ status: "idle" });
  };

  const { recording, stopRecording, input } = useSnapShotShortcutRecorder({
    shortcut: candidate,
    disabled: saving || !available,
    allowModifierPairs: false,
    subject: "screen capture",
    onStart: () => {
      checkIdRef.current++;
      setCheck({ status: "idle" });
    },
    onRecord: (shortcut) => {
      if (!isModifierPairShortcut(shortcut)) void checkShortcut(shortcut);
    },
    onError: (message) =>
      setCheck({
        status: "checked",
        shortcut: candidate,
        availability: { available: false, message },
      }),
  });

  const save = async (shortcut: SnapShotKeyChord) => {
    setSaving(true);
    try {
      await updateClientSettings({ scrawlShortcut: shortcut });
    } catch {
      setCheck({
        status: "checked",
        shortcut,
        availability: { available: false, message: "The shortcut could not be saved" },
      });
    } finally {
      setSaving(false);
    }
  };

  const savedLabel = formatSnapShotShortcutLabel(saved);
  const status = recording
    ? "Press your shortcut. Esc cancels"
    : keybindingConflict !== null
      ? `T3 Code already uses this for "${commandLabel(keybindingConflict)}"`
      : usedBySnapShots
        ? "SnapShots already uses this shortcut"
        : check.status === "checking"
          ? "Checking shortcut…"
          : check.status === "checked"
            ? check.availability.available
              ? "Ready to save"
              : (check.availability.message ?? "This shortcut is not available")
            : shortcutState?.registered === false
              ? `Another program is holding ${savedLabel}. T3 Code takes it as soon as it is free, and the composer button works until then`
              : undefined;

  return (
    <SettingsSection id="scrawl" title="Screen capture">
      <SettingsUnavailableGroup
        message={available ? undefined : "Screen capture needs the desktop app."}
      >
        <SettingsRow
          {...searchableSetting("scrawl-shortcut")}
          description="Start and finish a capture from any app."
          status={status}
          control={
            <>
              {input}
              {changed ? (
                <>
                  <Button
                    size="xs"
                    disabled={!canSave || saving}
                    onClick={() => void save(candidate)}
                  >
                    {saving ? "Saving…" : "Save"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => {
                      stopRecording();
                      reset();
                    }}
                  >
                    Cancel
                  </Button>
                </>
              ) : !sameSnapShotShortcut(saved, DEFAULT_SCRAWL_SHORTCUT) ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => void checkShortcut(DEFAULT_SCRAWL_SHORTCUT)}
                >
                  Use default
                </Button>
              ) : null}
            </>
          }
        />
        <SettingsRow
          {...searchableSetting("scrawl-retention")}
          description="Old video goes to the bin first, then the capture. Pinned captures stay."
          control={
            <Menu>
              <MenuTrigger
                aria-label={`Keep screen captures: ${RETENTION_LABELS[retention]}`}
                render={<SelectButton size="sm" />}
                className="w-auto min-w-0"
                disabled={!available}
              >
                {RETENTION_LABELS[retention]}
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuRadioGroup
                  value={retention}
                  onValueChange={(value) =>
                    void updateClientSettings({ scrawlRetention: value as ScrawlRetention })
                  }
                >
                  {(Object.keys(RETENTION_LABELS) as Array<ScrawlRetention>).map((value) => (
                    <MenuRadioItem key={value} closeOnClick value={value}>
                      {RETENTION_LABELS[value]}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          }
        />
        <SettingsRow
          {...searchableSetting("scrawl-captures")}
          description={overviewText(captures ?? [])}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!available}
              onClick={() => setScrawlHistoryOpen(true)}
            >
              Show captures
            </Button>
          }
        />
      </SettingsUnavailableGroup>
    </SettingsSection>
  );
}
