import { type Component, CURSOR_MARKER, truncateToWidth } from "@earendil-works/pi-tui";
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

interface SlicedTranscript {
	lines: string[];
	protectedRows: Set<number>;
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const OVERSIZED_IMAGE_PLACEHOLDER = "[image is taller than the transcript viewport]";

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

function buildImageSafePages(lines: string[], viewportRows: number): ProtectedLineSpan[] {
	if (viewportRows <= 0) return [];
	const imageSpans = getProtectedLineSpans(lines);
	if (imageSpans.length === 0) return [];
	const imagesByStart = new Map(imageSpans.map((span) => [span.start, span]));
	const pages: ProtectedLineSpan[] = [];
	let pageStart = 0;
	let pageRows = 0;
	let index = 0;
	while (index < lines.length) {
		const image = imagesByStart.get(index);
		const itemEnd = image?.end ?? index + 1;
		const itemRows = image ? Math.min(image.end - image.start, 1) : 1;
		const renderedRows = image && image.end - image.start <= viewportRows ? image.end - image.start : itemRows;
		if (pageRows > 0 && pageRows + renderedRows > viewportRows) {
			pages.push({ start: pageStart, end: index });
			pageStart = index;
			pageRows = 0;
		}
		pageRows += renderedRows;
		index = itemEnd;
		if (pageRows === viewportRows) {
			pages.push({ start: pageStart, end: index });
			pageStart = index;
			pageRows = 0;
		}
	}
	if (pageStart < lines.length) pages.push({ start: pageStart, end: lines.length });
	return pages;
}

function resolveImageSafePage(
	state: TranscriptViewportState,
	pages: ProtectedLineSpan[],
	contentRows: number,
): TranscriptViewportRange {
	const scrollTop = Math.max(0, state.scrollTop);
	const page = pages.find((candidate) => scrollTop >= candidate.start && scrollTop < candidate.end) ?? pages.at(-1)!;
	return {
		state: { scrollTop: page.start, followTail: false },
		start: page.start,
		end: page.end,
		hiddenAbove: page.start,
		hiddenBelow: contentRows - page.end,
	};
}

function sliceTranscript(
	lines: string[],
	start: number,
	end: number,
	width: number,
	viewportRows: number,
): SlicedTranscript {
	const imageSpans = getProtectedLineSpans(lines);
	const oversizedImages = imageSpans.filter((span) => span.end - span.start > viewportRows);
	const partialImages = imageSpans.filter(
		(span) =>
			span.end - span.start <= viewportRows &&
			span.start < end &&
			span.end > start &&
			(span.start < start || span.end > end),
	);
	const partialZones = getOsc133ZoneSpans(lines).filter(
		(span) => span.start < end && span.end > start && (span.start < start || span.end > end),
	);
	const result: string[] = [];
	const protectedRows = new Set<number>();
	for (let index = start; index < end; index += 1) {
		const oversizedImage = oversizedImages.find((span) => index >= span.start && index < span.end);
		if (oversizedImage) {
			if (index === Math.max(start, oversizedImage.start)) {
				result.push(truncateToWidth(OVERSIZED_IMAGE_PLACEHOLDER, width, ""));
			}
			continue;
		}
		const partialImage = partialImages.find((span) => index >= span.start && index < span.end);
		if (partialImage) continue;
		let line = lines[index]!;
		if (partialZones.some((span) => index >= span.start && index < span.end)) {
			line = line
				.replaceAll(OSC133_ZONE_START, "")
				.replaceAll(OSC133_ZONE_END, "")
				.replaceAll(OSC133_ZONE_FINAL, "");
		}
		if (imageSpans.some((span) => index >= span.start && index < span.end)) protectedRows.add(result.length);
		result.push(line);
	}
	return { lines: result, protectedRows };
}

export class InteractiveViewport implements Component {
	private readonly getHeight: () => number;
	private readonly sections: InteractiveViewportSections;
	private state: TranscriptViewportState = { ...INITIAL_TRANSCRIPT_VIEWPORT_STATE };
	private contentRows = 0;
	private viewportRows = 0;
	private lastWidth: number | undefined;
	private lastTranscriptLines: string[] = [];
	private imageSafePages: ProtectedLineSpan[] = [];
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
		this.imageSafePages = buildImageSafePages(transcriptLines, this.viewportRows);
		this.range =
			!this.state.followTail && this.imageSafePages.length > 0
				? resolveImageSafePage(this.state, this.imageSafePages, this.contentRows)
				: resolveTranscriptViewport(this.state, this.contentRows, this.viewportRows);
		this.state = this.range.state;

		const visibleTranscript = sliceTranscript(
			transcriptLines,
			this.range.start,
			this.range.end,
			width,
			this.viewportRows,
		);
		const padding = Array.from({ length: this.viewportRows - visibleTranscript.lines.length }, () => "");
		const transcriptFrame = [...visibleTranscript.lines, ...padding];
		if (!this.range.state.followTail && transcriptFrame.length > 0 && this.sections.renderScrollIndicator) {
			const indicatorRow = transcriptFrame.findIndex((_line, index) => !visibleTranscript.protectedRows.has(index));
			if (indicatorRow !== -1) {
				transcriptFrame[indicatorRow] = this.sections.renderScrollIndicator(transcriptFrame[indicatorRow]!, width);
			}
		}
		return [...visibleHeader, ...transcriptFrame, ...bottomLines, ...footerLines];
	}

	pageUp(): void {
		if (this.imageSafePages.length > 0) {
			if (this.state.followTail) {
				const tail = resolveTranscriptViewport(this.state, this.contentRows, this.viewportRows);
				let index = this.imageSafePages.findIndex((page) => tail.start >= page.start && tail.start < page.end);
				if (
					index > 0 &&
					this.imageSafePages[index]!.start === tail.start &&
					this.imageSafePages[index]!.end === tail.end
				) {
					index -= 1;
				}
				if (index >= 0) {
					this.state = { scrollTop: this.imageSafePages[index]!.start, followTail: false };
					return;
				}
			}
			const index = this.imageSafePages.findIndex(
				(page) => this.state.scrollTop >= page.start && this.state.scrollTop < page.end,
			);
			this.state = {
				scrollTop: index > 0 ? this.imageSafePages[index - 1]!.start : 0,
				followTail: false,
			};
			return;
		}
		this.state = moveTranscriptViewport(this.state, this.contentRows, this.viewportRows, { type: "pageUp" });
	}

	pageDown(): void {
		if (this.imageSafePages.length > 0 && !this.state.followTail) {
			const index = this.imageSafePages.findIndex(
				(page) => this.state.scrollTop >= page.start && this.state.scrollTop < page.end,
			);
			const nextPage = this.imageSafePages[index + 1];
			this.state = nextPage
				? { scrollTop: nextPage.start, followTail: false }
				: moveTranscriptViewport(this.state, this.contentRows, this.viewportRows, { type: "end" });
			return;
		}
		this.state = moveTranscriptViewport(this.state, this.contentRows, this.viewportRows, { type: "pageDown" });
	}

	scrollBy(rows: number): void {
		if (!Number.isFinite(rows) || rows === 0) return;
		if (this.imageSafePages.length > 0) {
			if (rows < 0) this.pageUp();
			else this.pageDown();
			return;
		}
		this.state = moveTranscriptViewport(this.state, this.contentRows, this.viewportRows, {
			type: "scroll",
			rows,
		});
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
