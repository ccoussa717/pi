import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

function createEditor(): CustomEditor {
	initTheme("dark");
	const tui = {
		requestRender() {},
		terminal: { rows: 24 },
	} as unknown as TUI;
	return new CustomEditor(tui, getEditorTheme(), new KeybindingsManager());
}

describe("CustomEditor transcript navigation", () => {
	test("falls through to editor navigation when an app handler declines the key", () => {
		const editor = createEditor();
		let transcriptCalls = 0;
		editor.onConditionalAction("app.transcript.home", () => {
			transcriptCalls += 1;
			return false;
		});
		editor.setText("abc");

		editor.handleInput("\x1bOH");
		editor.handleInput("x");

		expect(transcriptCalls).toBe(1);
		expect(editor.getText()).toBe("xabc");
	});

	test("keeps extension shortcuts ahead of transcript actions", () => {
		const editor = createEditor();
		let transcriptCalls = 0;
		let extensionCalls = 0;
		editor.onConditionalAction("app.transcript.home", () => {
			transcriptCalls += 1;
			return true;
		});
		editor.onExtensionShortcut = () => {
			extensionCalls += 1;
			return true;
		};

		editor.handleInput("\x1bOH");

		expect(extensionCalls).toBe(1);
		expect(transcriptCalls).toBe(0);
	});
});
