import assert from "node:assert";
import { describe, it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.ts";
import { type Component, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

describe("TUI mouse wheel input", () => {
	it("routes SGR wheel events without inserting escape sequences into the editor", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		const directions: number[] = [];
		(tui as TUI & { onMouseWheel?: (direction: number) => void }).onMouseWheel = (direction) => {
			directions.push(direction);
		};

		tui.setFocus(recorder);
		tui.start();
		terminal.sendInput("\x1b[<64;20;5M");
		terminal.sendInput("\x1b[<65;20;5M");

		assert.deepStrictEqual(directions, [-1, 1]);
		assert.deepStrictEqual(recorder.inputs, []);
		tui.stop();
	});

	it("consumes wheel events even when the application has no wheel handler", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();

		tui.setFocus(recorder);
		tui.start();
		terminal.sendInput("\x1b[<64;20;5M");

		assert.deepStrictEqual(recorder.inputs, []);
		tui.stop();
	});

	it("consumes clicks, releases, horizontal wheels, and legacy mouse reports", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();

		tui.setFocus(recorder);
		tui.start();
		terminal.sendInput("\x1b[<0;20;5M");
		terminal.sendInput("\x1b[<0;20;5m");
		terminal.sendInput("\x1b[<66;20;5M");
		terminal.sendInput("\x1b[M 45");

		assert.deepStrictEqual(recorder.inputs, []);
		tui.stop();
	});

	it("routes split and batched mouse input after terminal buffering", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		const directions: number[] = [];
		const buffer = new StdinBuffer({ timeout: 10 });
		buffer.on("data", (sequence) => terminal.sendInput(sequence));
		tui.onMouseWheel = (direction) => directions.push(direction);

		tui.setFocus(recorder);
		tui.start();
		buffer.process("\x1b[<64;20");
		buffer.process(";5M\x1b[<0;20;5M\x1b[<65;20;5M");

		assert.deepStrictEqual(directions, [-1, 1]);
		assert.deepStrictEqual(recorder.inputs, []);
		buffer.destroy();
		tui.stop();
	});
});
