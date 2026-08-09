/**
 * The Agent Hub must surface each agent's active advisor: the roster row shows
 * an advisor chip (status glyph + name) and the detail panel lists every
 * advisor with its runtime status label. Agents without a live advisor render
 * no chip.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function makeHub(agents: AgentRegistry) {
	return new AgentHubOverlayComponent({
		settings: Settings.isolated(),
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
	});
}

function rosterCell(raw: string): string | undefined {
	const line = Bun.stripANSI(raw);
	if (!line.startsWith("│ ")) return undefined;
	const divider = line.indexOf("│", Math.max(2, Math.floor(line.length / 3)));
	if (divider < 0) return undefined;
	return line.slice(2, Math.max(2, divider - 1));
}

/** Text of one roster entry (header line + wrapped detail lines), stripped of ANSI. */
function renderedRosterEntry(hub: AgentHubOverlayComponent, id: string, width = 120): string {
	const cells = hub.render(width).map(rosterCell);
	const start = cells.findIndex(cell => cell?.includes(` ${id}`) === true);
	expect(start).toBeGreaterThanOrEqual(0);
	const entry: string[] = [];
	for (let i = start; i < cells.length; i++) {
		const cell = cells[i];
		if (cell === undefined || cell.trim().length === 0) break;
		entry.push(cell.trimEnd());
	}
	return entry.join("\n");
}

function advisorSession(advisors: { name: string; status: string }[]): AgentSession {
	return {
		getAdvisorStatusOverview: () => ({ configured: true, advisors }),
	} as unknown as AgentSession;
}

describe("Agent hub advisor display", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("shows every active advisor of a live agent in its roster row", () => {
		const agents = new AgentRegistry();
		agents.register({
			id: "TaskA",
			displayName: "Task A",
			kind: "sub",
			parentId: "Main",
			session: advisorSession([
				{ name: "alpha", status: "running" },
				{ name: "beta", status: "running" },
			]),
		});
		const hub = makeHub(agents);

		const entry = renderedRosterEntry(hub, "TaskA");
		expect(entry).toContain("alpha");
		expect(entry).toContain("beta");
		hub.dispose();
	});

	it("shows a non-running advisor chip without claiming it is active", () => {
		const agents = new AgentRegistry();
		agents.register({
			id: "TaskA",
			displayName: "Task A",
			kind: "sub",
			parentId: "Main",
			session: advisorSession([{ name: "alpha", status: "quota_exhausted" }]),
		});
		const hub = makeHub(agents);

		const entry = renderedRosterEntry(hub, "TaskA");
		expect(entry).toContain("alpha");
		expect(entry).toContain("✕");
		hub.dispose();
	});

	it("omits the advisor chip for agents without a live advisor", () => {
		const agents = new AgentRegistry();
		agents.register({
			id: "Plain",
			displayName: "Plain",
			kind: "sub",
			parentId: "Main",
			session: {} as AgentSession,
		});
		agents.register({ id: "Parked", displayName: "Parked", kind: "sub", parentId: "Main", session: null });
		const hub = makeHub(agents);

		for (const id of ["Plain", "Parked"]) {
			const entry = renderedRosterEntry(hub, id);
			expect(entry).not.toContain("alpha");
			expect(entry).not.toContain("●");
		}
		hub.dispose();
	});

	it("lists advisors with status labels in the detail panel", () => {
		const agents = new AgentRegistry();
		agents.register({
			id: "TaskA",
			displayName: "Task A",
			kind: "sub",
			parentId: "Main",
			session: advisorSession([
				{ name: "alpha", status: "running" },
				{ name: "beta", status: "paused" },
			]),
		});
		const hub = makeHub(agents);

		// Narrow terminal: Tab swaps the roster for the selected agent's detail panel.
		hub.handleInput("\t");
		const frame = hub.render(80).map(Bun.stripANSI).join("\n");
		expect(frame).toContain("Advisor");
		expect(frame).toContain("● alpha");
		expect(frame).toContain("○ beta [off]");
		hub.dispose();
	});
});
