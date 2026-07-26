import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("renders a green rail on every width-safe panel row", () => {
		initTheme("dark");

		const component = new UserMessageComponent("a long user message that wraps", undefined, 1);
		const lines = component.render(10);
		const rail = theme.fg("success", "▌");

		expect(lines[0]?.startsWith(OSC133_ZONE_START + rail)).toBe(true);
		expect(lines[lines.length - 1]?.startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL + rail)).toBe(true);
		expect(lines.every((line) => line.includes(rail))).toBe(true);
		expect(lines.every((line) => visibleWidth(line) === 10)).toBe(true);
	});

	test("never exceeds extremely narrow terminal widths", () => {
		initTheme("dark");
		const component = new UserMessageComponent("hello", undefined, 1);

		for (const width of [1, 2, 3, 4]) {
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});
