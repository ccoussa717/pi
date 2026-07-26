import { type Component, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { InteractiveViewport } from "../src/modes/interactive/components/interactive-viewport.ts";

class LinesComponent implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class ResponsiveLinesComponent implements Component {
	render(width: number): string[] {
		if (width >= 80) return Array.from({ length: 100 }, (_, index) => `line ${index + 1}`);
		return Array.from({ length: 100 }, (_, index) => [`line ${index + 1}.1`, `line ${index + 1}.2`]).flat();
	}

	invalidate(): void {}
}

class AnchoredResponsiveLinesComponent implements Component {
	render(width: number): string[] {
		const count = width >= 80 ? 100 : 150;
		const anchorIndex = width >= 80 ? 87 : 120;
		return Array.from({ length: count }, (_, index) =>
			index === anchorIndex ? "stable anchor" : `${width}:${index}`,
		);
	}

	invalidate(): void {}
}

describe("InteractiveViewport", () => {
	test("keeps header and bottom fixed while showing the transcript tail", () => {
		const header = new LinesComponent(["header 1", "header 2"]);
		const transcript = new LinesComponent(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`));
		const bottom = new LinesComponent(["status", "editor", "footer"]);
		const viewport = new InteractiveViewport(() => 12, { header, transcript, bottom });

		expect(viewport.render(80)).toEqual([
			"header 1",
			"header 2",
			"line 14",
			"line 15",
			"line 16",
			"line 17",
			"line 18",
			"line 19",
			"line 20",
			"status",
			"editor",
			"footer",
		]);
	});

	test("page navigation changes only transcript rows", () => {
		const header = new LinesComponent(["header"]);
		const transcript = new LinesComponent(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`));
		const bottom = new LinesComponent(["editor", "footer"]);
		const viewport = new InteractiveViewport(() => 10, { header, transcript, bottom });

		viewport.render(80);
		viewport.pageUp();

		expect(viewport.render(80)).toEqual([
			"header",
			"line 8",
			"line 9",
			"line 10",
			"line 11",
			"line 12",
			"line 13",
			"line 14",
			"editor",
			"footer",
		]);
	});

	test("shows a scroll indicator only while away from the tail", () => {
		const viewport = new InteractiveViewport(() => 8, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`)),
			bottom: new LinesComponent(["editor", "footer"]),
			renderScrollIndicator: (line) => `${line} ↑`,
		});

		expect(viewport.render(80).some((line) => line.endsWith(" ↑"))).toBe(false);
		viewport.pageUp();
		expect(viewport.render(80).some((line) => line.endsWith(" ↑"))).toBe(true);
		viewport.end();
		expect(viewport.render(80).some((line) => line.endsWith(" ↑"))).toBe(false);
	});

	test("new transcript rows do not move a paused viewport", () => {
		const header = new LinesComponent(["header"]);
		const transcript = new LinesComponent(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`));
		const bottom = new LinesComponent(["editor", "footer"]);
		const viewport = new InteractiveViewport(() => 10, { header, transcript, bottom });

		viewport.render(80);
		viewport.pageUp();
		transcript.lines.push("line 21", "line 22");

		expect(viewport.render(80).slice(1, 8)).toEqual([
			"line 8",
			"line 9",
			"line 10",
			"line 11",
			"line 12",
			"line 13",
			"line 14",
		]);
	});

	test("pads a short transcript to keep the bottom anchored", () => {
		const viewport = new InteractiveViewport(() => 8, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent(["message"]),
			bottom: new LinesComponent(["editor", "footer"]),
		});

		expect(viewport.render(80)).toEqual(["header", "message", "", "", "", "", "editor", "footer"]);
	});

	test("remeasures the transcript after terminal resize", () => {
		let height = 8;
		const viewport = new InteractiveViewport(() => height, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`)),
			bottom: new LinesComponent(["editor", "footer"]),
		});

		expect(viewport.render(80).slice(1, 6)).toEqual(["line 6", "line 7", "line 8", "line 9", "line 10"]);
		height = 6;
		expect(viewport.render(80)).toEqual(["header", "line 8", "line 9", "line 10", "editor", "footer"]);
	});

	test("preserves relative transcript position across width reflow", () => {
		const viewport = new InteractiveViewport(() => 10, {
			header: new LinesComponent(["header"]),
			transcript: new ResponsiveLinesComponent(),
			bottom: new LinesComponent(["editor", "footer"]),
		});

		viewport.render(80);
		viewport.pageUp();
		viewport.render(40);

		expect(viewport.getRange().start).toBeGreaterThan(170);
	});

	test("preserves an exact visible anchor across nonuniform width reflow", () => {
		const viewport = new InteractiveViewport(() => 10, {
			header: new LinesComponent(["header"]),
			transcript: new AnchoredResponsiveLinesComponent(),
			bottom: new LinesComponent(["editor", "footer"]),
		});

		viewport.render(80);
		viewport.pageUp();
		viewport.render(40);

		expect(viewport.getRange().start).toBe(120);
	});

	test("omits a Kitty image block that crosses the viewport boundary", () => {
		const kittyImage = "\x1b_Gr=3,i=7;payload\x1b\\";
		const viewport = new InteractiveViewport(() => 6, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent(["before", kittyImage, "", "", "after"]),
			bottom: new LinesComponent(["editor", "footer"]),
		});

		viewport.render(80);
		viewport.home();
		const lines = viewport.render(80);

		expect(lines.some((line) => line.includes("\x1b_G"))).toBe(false);
		expect(lines).toContain("before");
	});

	test("omits an iTerm image block when its reserved rows are clipped", () => {
		const itermImage = "\x1b[2A\x1b]1337;File=inline=1:payload\x07";
		const viewport = new InteractiveViewport(() => 6, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent(["before", "", "", itermImage, "after", "last"]),
			bottom: new LinesComponent(["editor", "footer"]),
		});

		viewport.render(80);
		viewport.home();
		viewport.pageDown();
		const lines = viewport.render(80);

		expect(lines.some((line) => line.includes("1337;File="))).toBe(false);
		expect(lines).toContain("after");
	});

	test("retains the focused editor cursor when bottom chrome exceeds terminal height", () => {
		const bottomLines = [
			"editor top",
			`prompt ${CURSOR_MARKER}`,
			"editor bottom",
			...Array.from({ length: 8 }, (_, index) => `footer ${index + 1}`),
		];
		const viewport = new InteractiveViewport(() => 6, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent(["message"]),
			bottom: new LinesComponent(bottomLines),
		});

		const lines = viewport.render(80);

		expect(lines).toHaveLength(6);
		expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
	});

	test("prioritizes the real cursor over arrow text while clipping the composer", () => {
		const viewport = new InteractiveViewport(() => 3, {
			header: new LinesComponent([]),
			transcript: new LinesComponent([]),
			bottom: new LinesComponent([
				"→ widget text",
				"widget detail",
				"status",
				"editor top",
				"editor body",
				`prompt ${CURSOR_MARKER}`,
				"editor bottom",
			]),
		});

		expect(viewport.render(80).some((line) => line.includes(CURSOR_MARKER))).toBe(true);
	});

	test("keeps a multi-line custom footer when terminal space is available", () => {
		const footer = ["footer 1", "footer 2", "footer 3", "footer 4"];
		const viewport = new InteractiveViewport(() => 12, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent(["message"]),
			bottom: new LinesComponent([`prompt ${CURSOR_MARKER}`]),
			footer: new LinesComponent(footer),
		});

		const lines = viewport.render(80);

		for (const line of footer) expect(lines).toContain(line);
	});

	test("keeps the focused composer visible in a one-row terminal", () => {
		const viewport = new InteractiveViewport(() => 1, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent(["message"]),
			bottom: new LinesComponent([`prompt ${CURSOR_MARKER}`]),
			footer: new LinesComponent(["footer"]),
		});

		expect(viewport.render(80)).toEqual([`prompt ${CURSOR_MARKER}`]);
	});

	test("collapses overflowing bottom details before hiding the header", () => {
		const viewport = new InteractiveViewport(() => 12, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent(["message"]),
			bottom: new LinesComponent(["editor top", `prompt ${CURSOR_MARKER}`, "editor bottom"]),
			footer: new LinesComponent(Array.from({ length: 16 }, (_, index) => `footer ${index + 1}`)),
		});

		const lines = viewport.render(80);

		expect(lines).toHaveLength(12);
		expect(lines[0]).toBe("header");
		expect(lines).toContain("message");
		expect(lines.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
		expect(lines).toContain("footer 1");
	});

	test("does not split image blocks while clipping headers or footers", () => {
		const kittyImage = "\x1b_Gr=3,i=7;payload\x1b\\";
		const viewport = new InteractiveViewport(() => 5, {
			header: new LinesComponent(["header", kittyImage, "", "", "header end"]),
			transcript: new LinesComponent(["message"]),
			bottom: new LinesComponent(["editor"]),
			footer: new LinesComponent(["footer", kittyImage, "", ""]),
		});

		const lines = viewport.render(80);

		expect(lines.some((line) => line.includes("\x1b_G"))).toBe(false);
		expect(lines).toContain("header");
		expect(lines).toContain("footer");
	});

	test("strips partial OSC 133 zones at transcript boundaries", () => {
		const start = "\x1b]133;A\x07";
		const end = "\x1b]133;B\x07\x1b]133;C\x07";
		const viewport = new InteractiveViewport(() => 6, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent([`${start}message 1`, "message 2", "message 3", `${end}message 4`]),
			bottom: new LinesComponent(["editor", "footer"]),
		});

		viewport.render(80);
		viewport.home();
		const firstPage = viewport.render(80);
		viewport.pageDown();
		const secondPage = viewport.render(80);

		for (const lines of [firstPage, secondPage]) {
			expect(lines.some((line) => line.includes("\x1b]133;"))).toBe(false);
		}
	});

	test("preserves OSC 133 markers when the complete zone is visible", () => {
		const start = "\x1b]133;A\x07";
		const end = "\x1b]133;B\x07\x1b]133;C\x07";
		const viewport = new InteractiveViewport(() => 7, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent([`${start}message 1`, "message 2", "message 3", `${end}message 4`]),
			bottom: new LinesComponent(["editor", "footer"]),
		});

		const lines = viewport.render(80);

		expect(lines.some((line) => line.includes(start))).toBe(true);
		expect(lines.some((line) => line.includes(end))).toBe(true);
	});

	test("keeps complete OSC 133 zones when another visible zone is partial", () => {
		const start = "\x1b]133;A\x07";
		const end = "\x1b]133;B\x07\x1b]133;C\x07";
		const viewport = new InteractiveViewport(() => 8, {
			header: new LinesComponent(["header"]),
			transcript: new LinesComponent([
				`${start}partial 1`,
				"partial 2",
				"partial 3",
				`${end}partial 4`,
				`${start}complete 1`,
				`${end}complete 2`,
			]),
			bottom: new LinesComponent(["editor", "footer"]),
		});

		const lines = viewport.render(80);

		expect(lines.some((line) => line.includes(start) && line.includes("complete 1"))).toBe(true);
		expect(lines.some((line) => line.includes(end) && line.includes("complete 2"))).toBe(true);
		expect(lines.some((line) => line.includes("partial 4") && line.includes(end))).toBe(false);
	});
});
