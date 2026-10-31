import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  addDictationHistoryEntry,
  clearDictationHistory,
  listDictationHistory,
} from "../../dictation/dictationHistory";
import { DictationHistoryDialog } from "./DictationHistoryDialog";

const seed = async (count: number) => {
  await clearDictationHistory();
  for (let index = 0; index < count; index++) {
    await addDictationHistoryEntry({
      text: `Prompt ${index}`,
      createdAt: 1_790_000_000_000,
      structured: false,
    });
  }
};

describe("DictationHistoryDialog", () => {
  it("moves through the entries with the arrows and inserts on Enter, once closed", async () => {
    await seed(2);
    const onInsert = vi.fn();
    const onOpenChange = vi.fn();
    const dialog = (open: boolean) => (
      <DictationHistoryDialog
        open={open}
        onOpenChange={onOpenChange}
        dictateShortcutLabel="F9"
        onInsert={onInsert}
      />
    );
    await using screen = await render(dialog(true));
    await expect.element(page.getByText("Prompt 0")).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onInsert).not.toHaveBeenCalled();
    await screen.rerender(dialog(false));
    await vi.waitFor(() => expect(onInsert).toHaveBeenCalledWith("Prompt 0"));
  });

  it("loads older entries when scrolled to the end, and deletes for good", async () => {
    await seed(120);
    await using _screen = await render(
      <DictationHistoryDialog
        open
        onOpenChange={() => {}}
        dictateShortcutLabel="F9"
        onInsert={() => {}}
      />,
    );
    await expect.element(page.getByText("Prompt 119")).toBeVisible();
    await expect.element(page.getByText("Prompt 0", { exact: true })).not.toBeInTheDocument();
    const list = page.getByRole("list", { name: "Dictated prompts" }).element();
    const viewport = list.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.scrollTop = viewport.scrollHeight;
    await expect.element(page.getByText("Prompt 0", { exact: true })).toBeInTheDocument();

    await page.getByRole("button", { name: "Delete" }).first().click();
    await expect.element(page.getByText("Prompt 119")).not.toBeInTheDocument();
    await vi.waitFor(async () => {
      const [newest] = await listDictationHistory({ before: null, limit: 1 });
      expect(newest?.text).toBe("Prompt 118");
    });
  });
});
