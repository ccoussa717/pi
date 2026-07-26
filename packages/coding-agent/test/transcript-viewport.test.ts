import { describe, expect, test } from "vitest";
import {
	INITIAL_TRANSCRIPT_VIEWPORT_STATE,
	moveTranscriptViewport,
	resolveTranscriptViewport,
} from "../src/modes/interactive/transcript-viewport.ts";

describe("resolveTranscriptViewport", () => {
	test("initial state follows the transcript tail", () => {
		const range = resolveTranscriptViewport(INITIAL_TRANSCRIPT_VIEWPORT_STATE, 100, 30);

		expect(range).toEqual({
			state: { scrollTop: 70, followTail: true },
			start: 70,
			end: 100,
			hiddenAbove: 70,
			hiddenBelow: 0,
		});
	});

	test("page up moves one page and pauses tail following", () => {
		const state = moveTranscriptViewport(INITIAL_TRANSCRIPT_VIEWPORT_STATE, 100, 30, { type: "pageUp" });

		expect(state).toEqual({ scrollTop: 41, followTail: false });
	});

	test("navigation keeps following when the transcript does not overflow", () => {
		expect(moveTranscriptViewport(INITIAL_TRANSCRIPT_VIEWPORT_STATE, 5, 10, { type: "pageUp" })).toEqual({
			scrollTop: 0,
			followTail: true,
		});
		expect(moveTranscriptViewport(INITIAL_TRANSCRIPT_VIEWPORT_STATE, 5, 10, { type: "home" })).toEqual({
			scrollTop: 0,
			followTail: true,
		});
	});

	test("streamed growth preserves the visible anchor while scrolled", () => {
		const state = { scrollTop: 41, followTail: false };

		expect(resolveTranscriptViewport(state, 120, 30)).toMatchObject({
			state,
			start: 41,
			end: 71,
			hiddenBelow: 49,
		});
	});

	test("streamed growth advances a tail-following viewport", () => {
		const state = { scrollTop: 70, followTail: true };

		expect(resolveTranscriptViewport(state, 120, 30)).toMatchObject({
			state: { scrollTop: 90, followTail: true },
			start: 90,
			end: 120,
		});
	});

	test("page down resumes tail following when it reaches the end", () => {
		const state = moveTranscriptViewport({ scrollTop: 41, followTail: false }, 100, 30, { type: "pageDown" });

		expect(state).toEqual({ scrollTop: 70, followTail: true });
	});

	test("home and end select the transcript boundaries", () => {
		expect(moveTranscriptViewport(INITIAL_TRANSCRIPT_VIEWPORT_STATE, 100, 30, { type: "home" })).toEqual({
			scrollTop: 0,
			followTail: false,
		});
		expect(moveTranscriptViewport({ scrollTop: 0, followTail: false }, 100, 30, { type: "end" })).toEqual({
			scrollTop: 70,
			followTail: true,
		});
	});

	test("content shrink and resize clamp a paused viewport", () => {
		const range = resolveTranscriptViewport({ scrollTop: 70, followTail: false }, 50, 20);

		expect(range).toMatchObject({
			state: { scrollTop: 30, followTail: false },
			start: 30,
			end: 50,
		});
	});

	test("content shrink resumes following when every row fits", () => {
		const range = resolveTranscriptViewport({ scrollTop: 20, followTail: false }, 5, 10);

		expect(range.state).toEqual({ scrollTop: 0, followTail: true });
	});

	test("empty and zero-height viewports produce empty ranges", () => {
		expect(resolveTranscriptViewport(INITIAL_TRANSCRIPT_VIEWPORT_STATE, 0, 10)).toMatchObject({
			start: 0,
			end: 0,
			hiddenAbove: 0,
			hiddenBelow: 0,
		});
		expect(resolveTranscriptViewport(INITIAL_TRANSCRIPT_VIEWPORT_STATE, 10, 0)).toMatchObject({
			start: 10,
			end: 10,
			hiddenAbove: 10,
			hiddenBelow: 0,
		});
	});
});
