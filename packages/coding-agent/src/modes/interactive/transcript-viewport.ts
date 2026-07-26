export interface TranscriptViewportState {
	scrollTop: number;
	followTail: boolean;
}

export interface TranscriptViewportRange {
	state: TranscriptViewportState;
	start: number;
	end: number;
	hiddenAbove: number;
	hiddenBelow: number;
}

export const INITIAL_TRANSCRIPT_VIEWPORT_STATE: TranscriptViewportState = {
	scrollTop: 0,
	followTail: true,
};

export type TranscriptViewportAction =
	| { type: "pageUp" }
	| { type: "pageDown" }
	| { type: "home" }
	| { type: "end" }
	| { type: "scroll"; rows: number };

export function resolveTranscriptViewport(
	state: TranscriptViewportState,
	contentRows: number,
	viewportRows: number,
): TranscriptViewportRange {
	const safeContentRows = Math.max(0, contentRows);
	const safeViewportRows = Math.max(0, viewportRows);
	const maxScrollTop = Math.max(0, safeContentRows - safeViewportRows);
	const scrollTop = state.followTail ? maxScrollTop : Math.min(Math.max(0, state.scrollTop), maxScrollTop);
	const end = Math.min(safeContentRows, scrollTop + safeViewportRows);
	return {
		state: { scrollTop, followTail: maxScrollTop === 0 || state.followTail },
		start: scrollTop,
		end,
		hiddenAbove: scrollTop,
		hiddenBelow: safeContentRows - end,
	};
}

export function moveTranscriptViewport(
	state: TranscriptViewportState,
	contentRows: number,
	viewportRows: number,
	action: TranscriptViewportAction,
): TranscriptViewportState {
	const resolved = resolveTranscriptViewport(state, contentRows, viewportRows);
	const pageRows = Math.max(1, Math.max(0, viewportRows) - 1);
	const maxScrollTop = Math.max(0, Math.max(0, contentRows) - Math.max(0, viewportRows));
	switch (action.type) {
		case "pageUp":
			if (maxScrollTop === 0) return { scrollTop: 0, followTail: true };
			return {
				scrollTop: Math.max(0, resolved.start - pageRows),
				followTail: false,
			};
		case "pageDown": {
			const scrollTop = Math.min(maxScrollTop, resolved.start + pageRows);
			return { scrollTop, followTail: scrollTop === maxScrollTop };
		}
		case "home":
			return { scrollTop: 0, followTail: maxScrollTop === 0 };
		case "end":
			return { scrollTop: maxScrollTop, followTail: true };
		case "scroll": {
			const rows = Number.isFinite(action.rows) ? Math.trunc(action.rows) : 0;
			const scrollTop = Math.min(maxScrollTop, Math.max(0, resolved.start + rows));
			return { scrollTop, followTail: scrollTop === maxScrollTop };
		}
	}
}
