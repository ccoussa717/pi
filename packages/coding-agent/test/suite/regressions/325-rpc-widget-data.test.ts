import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rpcIo.outputLines.push(line),
}));

vi.mock("../../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];

function listenerSnapshot(): { stdinEnd: NodeListener[]; signals: Map<NodeJS.Signals, NodeListener[]> } {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

function restoreListeners(snapshot: ReturnType<typeof listenerSnapshot>): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previous] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previous.includes(listener)) process.off(signal, listener);
		}
	}
}

function records(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runtimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

describe("RPC extension widget data", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("publishes JSON-safe structured data and preserves fallback lines for invalid data", async () => {
		const listeners = listenerSnapshot();
		const data = {
			kind: "alloy.fusion.live",
			version: 1,
			agents: [{ role: "architect", status: "running" }],
		};
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const deep: Record<string, unknown> = {};
		let cursor = deep;
		for (let depth = 0; depth < 66; depth++) {
			const next: Record<string, unknown> = {};
			cursor.next = next;
			cursor = next;
		}
		const hostile: Record<string, unknown> = {};
		Object.defineProperty(hostile, "value", {
			enumerable: true,
			get() {
				throw new Error("hostile getter");
			},
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						ctx.ui.setWidget("fusion-live", ["Fusion running"], {
							placement: "aboveEditor",
							data,
						});
						ctx.ui.setWidget("fusion-cyclic", ["Cyclic fallback"], { data: cyclic as never });
						ctx.ui.setWidget("fusion-nonfinite", ["Number fallback"], {
							data: { value: Number.NaN } as never,
						});
						ctx.ui.setWidget("fusion-legacy", ["Legacy fallback"]);
						ctx.ui.setWidget("fusion-deep", ["Deep fallback"], { data: deep as never });
						ctx.ui.setWidget("fusion-hostile", ["Hostile fallback"], { data: hostile as never });
					});
				},
			],
		});

		try {
			void runRpcMode(runtimeHost(harness));
			await vi.waitFor(() => {
				const published = records();
				expect(published).toContainEqual(
					expect.objectContaining({
						type: "extension_ui_request",
						method: "setWidget",
						widgetKey: "fusion-live",
						widgetLines: ["Fusion running"],
						widgetPlacement: "aboveEditor",
						widgetData: data,
					}),
				);
				expect(published).toContainEqual(
					expect.objectContaining({
						method: "setWidget",
						widgetKey: "fusion-cyclic",
						widgetLines: ["Cyclic fallback"],
					}),
				);
				expect(published).toContainEqual(
					expect.objectContaining({
						method: "setWidget",
						widgetKey: "fusion-nonfinite",
						widgetLines: ["Number fallback"],
					}),
				);
				expect(published).toContainEqual(
					expect.objectContaining({
						method: "setWidget",
						widgetKey: "fusion-legacy",
						widgetLines: ["Legacy fallback"],
					}),
				);
				for (const key of ["fusion-cyclic", "fusion-nonfinite", "fusion-legacy", "fusion-deep", "fusion-hostile"]) {
					const record = published.find((item) => item.widgetKey === key);
					expect(record).not.toHaveProperty("widgetData");
				}
			});
		} finally {
			harness.cleanup();
			restoreListeners(listeners);
		}
	});
});
