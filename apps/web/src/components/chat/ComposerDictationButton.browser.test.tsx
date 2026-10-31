import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { DictationState } from "../../dictation/useDictation";
import { ComposerDictationButton } from "./ComposerDictationButton";

const IDLE: DictationState = { phase: "idle", preview: "", structured: false, notice: null };

const renderButton = (onLanguageChange: (language: string) => void) =>
  render(
    <ComposerDictationButton
      state={IDLE}
      onToggle={() => {}}
      dictateShortcutLabel={null}
      structuredShortcutLabel={null}
      language="de"
      onLanguageChange={onLanguageChange}
    />,
  );

describe("ComposerDictationButton", () => {
  it("switches the language from the menu behind the arrow", async () => {
    const onLanguageChange = vi.fn();
    await using screen = await renderButton(onLanguageChange);
    await userEvent.click(screen.getByRole("button", { name: "Dictation language: Deutsch" }));
    await userEvent.click(page.getByRole("menuitemradio", { name: "English" }));
    expect(onLanguageChange.mock.calls[0]?.[0]).toBe("en");
  });

  it("adds no height to the footer row beyond the mic", async () => {
    await using screen = await renderButton(() => {});
    const mic = screen.getByRole("button", { name: "Dictate" }).element().getBoundingClientRect();
    const row = screen
      .getByRole("button", { name: "Dictate" })
      .element()
      .parentElement!.getBoundingClientRect();
    expect(row.height).toBe(mic.height);
  });
});
