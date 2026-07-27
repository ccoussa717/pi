import { Readable } from "node:stream";
import { describe, expect, test } from "vitest";
import { compactJsonEvent } from "../src/modes/print-mode.ts";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.ts";

describe("RPC JSONL framing", () => {
	test("compact print events retain deltas without cumulative assistant snapshots", () => {
		const partial = {
			role: "assistant",
			content: [{ type: "text", text: "a long cumulative answer" }],
		};
		const event = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "answer",
				partial,
			},
		};

		expect(compactJsonEvent(event)).toEqual({
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "answer",
			},
		});
	});

	test("compact print events leave terminal messages intact", () => {
		const event = {
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "complete" }] },
		};
		expect(compactJsonEvent(event)).toBe(event);
	});

	test("compact print event volume scales with deltas rather than cumulative snapshots", () => {
		let text = "";
		let fullBytes = 0;
		let compactBytes = 0;
		for (let i = 0; i < 1000; i++) {
			text += "streaming output ";
			const partial = { role: "assistant", content: [{ type: "text", text }] };
			const event = {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streaming output ", partial },
			};
			fullBytes += Buffer.byteLength(JSON.stringify(event));
			compactBytes += Buffer.byteLength(JSON.stringify(compactJsonEvent(event)));
		}

		expect(compactBytes).toBeLessThan(fullBytes / 100);
	});

	test("serializes strict JSONL records without escaping Unicode separators", () => {
		const line = serializeJsonLine({ text: "a\u2028b\u2029c" });

		expect(line).toContain("a\u2028b\u2029c");
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line.trim())).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("splits on LF only and preserves U+2028/U+2029 inside payloads", async () => {
		const lines: string[] = [];
		const stream = Readable.from([serializeJsonLine({ text: "a\u2028b\u2029c" })]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toEqual({ text: "a\u2028b\u2029c" });
	});

	test("handles CRLF-delimited input", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}\r\n{"b":2}\r\n')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
	});

	test("emits a final line without trailing LF", async () => {
		const lines: string[] = [];
		const stream = Readable.from([Buffer.from('{"a":1}')]);

		const done = new Promise<void>((resolve) => {
			stream.on("end", resolve);
		});

		attachJsonlLineReader(stream, (line) => {
			lines.push(line);
		});

		await done;

		expect(lines).toEqual(['{"a":1}']);
	});
});
