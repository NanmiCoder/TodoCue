import { describe, expect, it } from "vitest";
import { composerDraft, draftPayload, newDraft } from "../src/drafts.js";

describe("full composer entry follows the original draft rules", () => {
  it("opens an unplanned blank task without transferring unrelated quick input", () => {
    const draft = composerDraft(undefined, "2026-10-14");
    expect(draft.title).toBe("");
    expect(draftPayload({ ...draft, title: "Blank task" }).scheduledDate).toBeNull();
  });
  it("continues an existing draft from an empty entry", () => {
    const saved = { ...newDraft(), title: "Previous draft", notes: "Keep notes" };
    expect(composerDraft(saved, "2026-10-14", "", true)).toBe(saved);
  });
  it("expands typed input into a separate task without old notes or attachments", () => {
    const saved = { ...newDraft(), title: "Previous draft", notes: "Private to the previous draft", project: "Old project",
      uploads: [{ name: "old.txt", mediaType: "text/plain", dataBase64: "b2xk" }] };
    const next = composerDraft(saved, "2026-10-14", "New task", true);
    expect(next.title).toBe("New task");
    expect(next.notes).toBe("");
    expect(next.project).toBe("");
    expect(next.uploads).toEqual([]);
    expect(next.sessionId).not.toBe(saved.sessionId);
    expect(draftPayload(next).scheduledDate).toBe("2026-10-14");
  });
  it("uses the calendar's selected date while keeping a continued draft's content", () => {
    const saved = { ...newDraft(), title: "Previous draft", notes: "Keep notes" };
    const next = composerDraft(saved, "2026-10-20", "", true, true);
    expect(next.notes).toBe(saved.notes);
    expect(next.title).toBe(saved.title);
    expect(next.sessionId).toBe(saved.sessionId);
    expect(next.key).not.toBe(saved.key);
    expect(draftPayload(next).scheduledDate).toBe("2026-10-20");
  });
});
