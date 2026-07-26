import { type Component, CURSOR_MARKER } from "@earendil-works/pi-tui";
import {
	INITIAL_TRANSCRIPT_VIEWPORT_STATE,
	moveTranscriptViewport,
	resolveTranscriptViewport,
	type TranscriptViewportRange,
	type TranscriptViewportState,
} from "../transcript-viewport.ts";

export interface InteractiveViewportSections {
	header: Component;
	transcript: Component;
	bottom: Component;
	footer?: Component;
	renderScrollIndicator?: (line: string, width: number) => string;
}

interface ProtectedLineSpan {
	start: number;
	end: number;
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function getProtectedLineSpans(lines: string[]): ProtectedLineSpan[] {
	const spans: ProtectedLineSpan[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		const kittyHeader = line.match(/\x1b_G([^;]*);/);
		if (kittyHeader) {
			const rowsParameter = kittyHeader[1]?.split(",").find((parameter) => parameter.startsWith("r="));
			const rows = Number(rowsParameter?.slice(2));
			if (Number.isInteger(rows) && rows > 1) {
				spans.push({ start: index, end: Math.min(lines.length, index + rows) });
			}
		}

		if (line.includes("\x1b]1337;File=")) {
			const cursorUp = line.match(/\x1b\[(\d+)A/);
			const reservedRows = Number(cursorUp?.[1]);
			if (Number.isInteger(reservedRows) && reservedRows > 0) {
				spans.push({ start: Math.max(0, index - reservedRows), end: index + 1 });
			}
		}
	}
	return spans;
}

function sliceCompleteBlocks(lines: string[], start: number, end: number): string[] {
	const partialSpans = getProtectedLineSpans(lines).filter(
		(span) => span.start < end && span.end > start && (span.start < start || span.end > end),
	);
	return lines.slice(start, end).filter((_line, offset) => {
		const index = start + offset;
		return partialSpans.every((span) => index < span.start || index >= span.end);
	});
}

function clipBottomLines(lines: string[], height: number): string[] {
	if (height <= 0) return [];
	if (lines.length <= height) return lines;
	const tailStart = lines.length - height;
	let activeLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
	if (activeLine === -1) activeLine = lines.findIndex((line) => line.includes("→ "));
	if (activeLine === -1 || activeLine >= tailStart) return sliceCompleteBlocks(lines, tailStart, lines.length);
	const start = Math.max(0, activeLine - Math.min(2, height - 1));
	return sliceCompleteBlocks(lines, start, start + height);
}

function getOsc133ZoneSpans(lines: string[]): ProtectedLineSpan[] {
	const spans: ProtectedLineSpan[] = [];
	let start: number | undefined;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		if (line.includes(OSC133_ZONE_START)) start = index;
		if (start !== undefined && line.includes(OSC133_ZONE_END)) {
			spans.push({ start, end: index + 1 });
			start = undefined;
		}
	}
	if (start !== undefined) spans.push({ start, end: lines.length });
	return spans;
}

function sliceTranscript(lines: string[], start: number, end: number): string[] {
	const partialImages = getProtectedLineSpans(lines).filter(
		(span) => span.start < end && span.end > start && (span.start < start || span.end > end),
	);
	const partialZones = getOsc133ZoneSpans(lines).filter(
		(span) => span.start < end && span.end > start && (span.start < start || span.end > end),
	);
	const result: string[] = [];
	for (let index = start; index < end; index += 1) {
		if (partialImages.some((span) => index >= span.start && index < span.end)) continue;
		let line = lines[index]!;
		if (partialZones.some((span) => index >= span.start && index < span.end)) {
			line = line
				.replaceAll(OSC133_ZONE_START, "")
				.replaceAll(OSC133_ZONE_END, "")
				.replaceAll(OSC133_ZONE_FINAL, "");
		}
		result.push(line);
	}
	return result;
}

export class InteractiveViewport implements Component {
	private readonly getHeight: () => number;
	private readonly sections: InteractiveViewportSections;
	private state: TranscriptViewportState = { ...INITIAL_TRANSCRIPT_VIEWPORT_STATE };
	private contentRows = 0;
	private viewportRows = 0;
	private lastWidth: number | undefined;
	private lastTranscriptLines: string[] = [];
	private range: TranscriptViewportRange = resolveTranscriptViewport(this.state, 0, 0);

	constructor(getHeight: () => number, sections: InteractiveViewportSections) {
		this.getHeight = getHeight;
		this.sections = sections;
	}

	render(width: number): string[] {
		const height = Math.max(0, Math.floor(this.getHeight()));
		if (height === 0) return [];

		const headerLines = this.sections.header.render(width);
		const bottomSourceLines = this.sections.bottom.render(width);
		const footerSourceLines = this.sections.footer?.render(width) ?? [];
		const transcriptLines = this.sections.transcript.render(width);
		const headerReserve = headerLines.length > 0 ? 1 : 0;
		const transcriptReserve = transcriptLines.length > 0 ? 1 : 0;
		const footerReserve = footerSourceLines.length > 0 ? 1 : 0;
		const bottomBudget = Math.min(
			height,
			Math.max(bottomSourceLines.length > 0 ? 1 : 0, height - headerReserve - transcriptReserve - footerReserve),
		);
		const bottomLines = clipBottomLines(bottomSourceLines, bottomBudget);
		const footerBudget = Math.max(0, height - bottomLines.length - headerReserve - transcriptReserve);
		const footerLines = this.sections.footer
			? sliceCompleteBlocks(footerSourceLines, 0, Math.min(footerSourceLines.length, footerBudget))
			: [];
		const headerRows = Math.max(0, height - bottomLines.length - footerLines.length - transcriptReserve);
		const visibleHeader = sliceCompleteBlocks(headerLines, 0, headerRows);

		const contentRows = transcriptLines.length;
		const viewportRows = Math.max(0, height - visibleHeader.length - bottomLines.length - footerLines.length);
		if (this.lastWidth !== undefined && width !== this.lastWidth && !this.state.followTail) {
			const previousMaxScrollTop = Math.max(0, this.contentRows - this.viewportRows);
			const nextMaxScrollTop = Math.max(0, contentRows - viewportRows);
			if (previousMaxScrollTop > 0) {
				const projectedScrollTop = Math.round((this.state.scrollTop / previousMaxScrollTop) * nextMaxScrollTop);
				const anchor = this.lastTranscriptLines[this.state.scrollTop];
				const anchorMatches = anchor
					? transcriptLines.flatMap((line, index) => (line === anchor ? [index] : []))
					: [];
				const scrollTop = anchorMatches.reduce(
					(closest, match) =>
						Math.abs(match - projectedScrollTop) < Math.abs(closest - projectedScrollTop) ? match : closest,
					anchorMatches[0] ?? projectedScrollTop,
				);
				this.state = {
					...this.state,
					scrollTop,
				};
			}
		}
		this.lastWidth = width;
		this.lastTranscriptLines = transcriptLines;
		this.contentRows = contentRows;
		this.viewportRows = viewportRows;
		this.range = resolveTranscriptViewport(this.state, this.contentRows, this.viewportRows);
		this.state = this.range.state;

		const visibleTranscript = sliceTranscript(transcriptLines, this.range.start, this.range.end);
		const padding = Array.from({ length: this.viewportRows - visibleTranscript.length }, () => "");
		const transcriptFrame = [...visibleTranscript, ...padding];
		if (!this.range.state.followTail && transcriptFrame.length > 0 && this.sections.renderScrollIndicator) {
			transcriptFrame[0] = this.sections.renderScrollIndicator(transcriptFrame[0]!, width);
		}
		return [...visibleHeader, ...transcriptFrame, ...bottomLines, ...footerLines];
	}

	pageUp(): void {
		this.state = moveTranscriptViewport(this.state, this.contentRows, this.viewportRows, { type: "pageUp" });
	}

	pageDown(): void {
		this.state = moveTranscriptViewport(this.state, this.contentRows, this.viewportRows, { type: "pageDown" });
	}

	home(): void {
		this.state = moveTranscriptViewport(this.state, this.contentRows, this.viewportRows, { type: "home" });
	}

	end(): void {
		this.state = moveTranscriptViewport(this.state, this.contentRows, this.viewportRows, { type: "end" });
	}

	reset(): void {
		this.state = { ...INITIAL_TRANSCRIPT_VIEWPORT_STATE };
	}

	getRange(): TranscriptViewportRange {
		return this.range;
	}

	invalidate(): void {
		this.sections.header.invalidate();
		this.sections.transcript.invalidate();
		this.sections.bottom.invalidate();
		this.sections.footer?.invalidate();
	}
}
