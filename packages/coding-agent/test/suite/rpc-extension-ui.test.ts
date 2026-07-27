import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "./harness.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rpcIo.outputLines.push(line),
}));

vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
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

describe("RPC extension UI lifecycle", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("closes host dialogs on abort or timeout without closing an answered dialog", async () => {
		const listeners = listenerSnapshot();
		const controller = new AbortController();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						void ctx.ui.input("Complete login", "redirect URL", { signal: controller.signal, timeout: 500 });
						void ctx.ui.confirm("Timed approval", "Confirm before timeout", { timeout: 20 });
						void ctx.ui.select("Answered selection", ["one", "two"], { timeout: 500 });
					});
				},
			],
		});

		try {
			void runRpcMode(runtimeHost(harness));
			const dialogIds = new Map<string, string>();
			await vi.waitFor(() => {
				const opened = records().filter(
					(record) =>
						record.type === "extension_ui_request" &&
						["input", "confirm", "select"].includes(String(record.method)),
				);
				expect(opened).toHaveLength(3);
				for (const record of opened) dialogIds.set(String(record.method), String(record.id));
			});
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler!(
				JSON.stringify({
					type: "extension_ui_response",
					id: dialogIds.get("select"),
					value: "one",
				}),
			);
			await new Promise((resolve) => setImmediate(resolve));
			controller.abort();

			await vi.waitFor(() => {
				const closedIds = records()
					.filter((record) => record.type === "extension_ui_request" && record.method === "close")
					.map((record) => record.id);
				expect(closedIds).toEqual(expect.arrayContaining([dialogIds.get("input"), dialogIds.get("confirm")]));
			});
			await new Promise((resolve) => setTimeout(resolve, 520));
			const closedIds = records()
				.filter((record) => record.type === "extension_ui_request" && record.method === "close")
				.map((record) => record.id);
			expect(closedIds.filter((id) => id === dialogIds.get("input"))).toHaveLength(1);
			expect(closedIds.filter((id) => id === dialogIds.get("confirm"))).toHaveLength(1);
			expect(closedIds).not.toContain(dialogIds.get("select"));
		} finally {
			harness.cleanup();
			restoreListeners(listeners);
		}
	});
});
