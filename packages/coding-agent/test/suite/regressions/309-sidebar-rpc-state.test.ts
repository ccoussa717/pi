import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/index.ts";
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
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
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

function mutableRuntimeHost(initialHarness: Harness): {
	host: AgentSessionRuntime;
	useHarness: (harness: Harness) => void;
	rebind: () => Promise<void>;
} {
	let harness = initialHarness;
	let rebindSession: (() => Promise<void>) | undefined;
	const host = {
		get session() {
			return harness.session;
		},
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn((callback: () => Promise<void>) => {
			rebindSession = callback;
		}),
	} as unknown as AgentSessionRuntime;
	return {
		host,
		useHarness(nextHarness) {
			harness = nextHarness;
		},
		async rebind() {
			if (!rebindSession) throw new Error("RPC rebind callback is unavailable");
			await rebindSession();
		},
	};
}

describe("Alloy sidebar RPC state", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("hydrates and publishes complete replacement snapshots without session entries", async () => {
		const listeners = listenerSnapshot();
		let publish: ExtensionUIContext["setSidebarState"];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						if (!ctx.ui.setSidebarState) throw new Error("RPC sidebar state publisher is unavailable");
						publish = ctx.ui.setSidebarState.bind(ctx.ui);
						publish({
							mcp: [{ name: "open-brain", status: "connected", toolCount: 3, transport: "http" }],
							lsp: { supported: false, enabled: false, items: [] },
							todos: [],
						});
					});
				},
			],
		});

		try {
			const runtime = mutableRuntimeHost(harness);
			void runRpcMode(runtime.host);
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			rpcIo.lineHandler?.(JSON.stringify({ id: "sidebar-1", type: "get_sidebar_state" }));

			await vi.waitFor(() => {
				expect(records()).toContainEqual(
					expect.objectContaining({
						id: "sidebar-1",
						type: "response",
						command: "get_sidebar_state",
						success: true,
						data: expect.objectContaining({
							sessionId: harness.session.sessionId,
							context: expect.objectContaining({ cost: 0 }),
							mcp: [{ name: "open-brain", status: "connected", toolCount: 3, transport: "http" }],
						}),
					}),
				);
			});

			const beforeInvalidPublish = records().length;
			expect(() =>
				publish!({
					mcp: [{ name: "invalid", status: "bogus" }],
					lsp: { supported: false, enabled: false, items: [] },
					todos: [],
				} as never),
			).toThrow("Invalid sidebar MCP status");
			expect(records()).toHaveLength(beforeInvalidPublish);

			publish!({
				mcp: [{ name: "open-brain", status: "failed", error: "offline", transport: "http" }],
				lsp: { supported: false, enabled: false, items: [] },
				todos: [],
			});

			await vi.waitFor(() => {
				expect(records()).toContainEqual(
					expect.objectContaining({
						type: "sidebar_state_updated",
						data: expect.objectContaining({
							sessionId: harness.session.sessionId,
							mcp: [{ name: "open-brain", status: "failed", error: "offline", transport: "http" }],
						}),
					}),
				);
			});
			expect(harness.sessionManager.getEntries()).toEqual([]);

			const publishedBeforePrompt = records().filter((record) => record.type === "sidebar_state_updated").length;
			harness.setResponses([fauxAssistantMessage("done")]);
			rpcIo.lineHandler?.(JSON.stringify({ id: "prompt-1", type: "prompt", message: "refresh context" }));

			await vi.waitFor(() => {
				const output = records();
				const types = output.map((record) => record.type);
				const settledIndex = types.lastIndexOf("agent_settled");
				const sidebarIndex = types.lastIndexOf("sidebar_state_updated");
				expect(settledIndex).toBeGreaterThan(-1);
				expect(sidebarIndex).toBeGreaterThan(settledIndex);
				expect(output.filter((record) => record.type === "sidebar_state_updated").length).toBeGreaterThan(
					publishedBeforePrompt,
				);
			});
		} finally {
			harness.cleanup();
			restoreListeners(listeners);
		}
	});

	test("clears replacement sessions and ignores publishers from the prior binding", async () => {
		const listeners = listenerSnapshot();
		let oldPublish: ExtensionUIContext["setSidebarState"];
		const first = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						if (!ctx.ui.setSidebarState) throw new Error("RPC sidebar state publisher is unavailable");
						oldPublish = ctx.ui.setSidebarState.bind(ctx.ui);
						oldPublish({
							mcp: [{ name: "old", status: "connected" }],
							lsp: { supported: false, enabled: false, items: [] },
							todos: [],
						});
					});
				},
			],
		});
		const second = await createHarness();
		const runtime = mutableRuntimeHost(first);

		try {
			void runRpcMode(runtime.host);
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			runtime.useHarness(second);
			await runtime.rebind();

			await vi.waitFor(() => {
				expect(records()).toContainEqual(
					expect.objectContaining({
						type: "sidebar_state_updated",
						data: expect.objectContaining({ sessionId: second.session.sessionId, mcp: [] }),
					}),
				);
			});

			const beforeStalePublish = records().length;
			oldPublish!({
				mcp: [{ name: "stale", status: "failed" }],
				lsp: { supported: false, enabled: false, items: [] },
				todos: [],
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(records()).toHaveLength(beforeStalePublish);
		} finally {
			first.cleanup();
			second.cleanup();
			restoreListeners(listeners);
		}
	});
});
