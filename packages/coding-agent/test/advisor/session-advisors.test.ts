import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveAdvisorEntryModel } from "../../src/config/model-resolver";
import { Settings } from "../../src/config/settings";
import { createAdvisorAgent, resolveAdvisorRosterEntry } from "../../src/session/session-advisors";
import type { AgentDefinition } from "../../src/task/types";

const SONNET_MODEL: Model = buildModel({
	provider: "anthropic",
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 8192,
});
const GPT_MODEL: Model = buildModel({
	provider: "openai",
	id: "gpt-5.4",
	name: "GPT-5.4",
	api: "openai-responses",
	baseUrl: "https://api.openai.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

describe("createAdvisorAgent", () => {
	it("wraps a definition in the advisor role: strips spawning tools, clears driving-agent concerns, preserves identity", () => {
		const definition: AgentDefinition = {
			name: "security-reviewer",
			description: "Reviews each primary turn for safety and correctness.",
			systemPrompt: "Watch module boundaries.",
			tools: ["read", "grep", "write", "task", "hub", "yield"],
			spawns: "*",
			prewalk: true,
			output: { type: "object", properties: {} },
			model: ["anthropic/claude-sonnet-4-5:high"],
			advisors: { other: null },
			source: "user" as const,
		};

		const advisor = createAdvisorAgent(definition);

		// The recursion cut: an advisor can never grow subagents — and therefore
		// advisors — of its own.
		expect(advisor.tools).toEqual(["read", "grep", "write"]);
		expect(advisor.spawns).toBeUndefined();
		expect(advisor.prewalk).toBeUndefined();
		expect(advisor.output).toBeUndefined();
		// Identity and expertise survive untouched.
		expect(advisor.name).toBe("security-reviewer");
		expect(advisor.description).toBe("Reviews each primary turn for safety and correctness.");
		expect(advisor.systemPrompt).toBe("Watch module boundaries.");
		expect(advisor.model).toEqual(["anthropic/claude-sonnet-4-5:high"]);
		expect(advisor.source).toBe("user");
		expect(advisor.advisors).toEqual({ other: null });
	});

	it("leaves a definition with no tools and no driving-agent fields unchanged", () => {
		const definition: AgentDefinition = {
			name: "observer",
			description: "Observes only.",
			systemPrompt: "",
			source: "user" as const,
		};

		expect(createAdvisorAgent(definition)).toEqual(definition);
	});
});

describe("resolveAdvisorRosterEntry", () => {
	it('resolves the reserved "default" name to the built-in default advisor when no roster definition matches', () => {
		expect(resolveAdvisorRosterEntry([], "default")).toEqual({ definition: undefined, builtinDefault: true });
	});

	it('lets an explicit roster definition named "default" win over the built-in', () => {
		const definition: AgentDefinition = {
			name: "default",
			description: "An explicit default advisor.",
			systemPrompt: "",
			source: "user" as const,
		};

		expect(resolveAdvisorRosterEntry([definition], "default")).toEqual({ definition, builtinDefault: false });
	});

	it("returns undefined for a name that matches neither the roster nor the reserved name", () => {
		expect(resolveAdvisorRosterEntry([], "no-such-agent")).toBeUndefined();
	});

	it("resolves an ordinary roster definition", () => {
		const definition: AgentDefinition = {
			name: "security-reviewer",
			description: "Reviews each primary turn for safety and correctness.",
			systemPrompt: "Watch module boundaries.",
			tools: ["read", "grep", "write"],
			source: "user" as const,
		};

		expect(resolveAdvisorRosterEntry([definition], "security-reviewer")).toEqual({
			definition,
			builtinDefault: false,
		});
	});
});

describe("resolveAdvisorEntryModel", () => {
	const registry = { getAvailable: () => [SONNET_MODEL, GPT_MODEL] };
	const reviewer: AgentDefinition = {
		name: "reviewer",
		description: "Code reviewer.",
		systemPrompt: "",
		model: ["anthropic/claude-sonnet-4-5"],
		source: "user" as const,
	};

	it("lets the driving agent's per-entry override win over the advisor's own model", () => {
		const settings = Settings.isolated();
		settings.setModelRole("advisor", "openai/gpt-5.4");

		const resolved = resolveAdvisorEntryModel({
			override: "openai/gpt-5.4",
			definition: reviewer,
			settings,
			modelRegistry: registry,
		});

		expect(resolved?.model.id).toBe("gpt-5.4");
	});

	it("returns undefined for an unresolvable override instead of silently falling back", () => {
		const settings = Settings.isolated();
		settings.setModelRole("advisor", "openai/gpt-5.4");

		const resolved = resolveAdvisorEntryModel({
			override: "anthropic/does-not-exist",
			definition: reviewer,
			settings,
			modelRegistry: registry,
		});

		expect(resolved).toBeUndefined();
	});

	it("uses the advisor's own model patterns before the role chain", () => {
		const settings = Settings.isolated();
		settings.setModelRole("advisor", "openai/gpt-5.4");

		const resolved = resolveAdvisorEntryModel({
			override: null,
			definition: reviewer,
			settings,
			modelRegistry: registry,
		});

		expect(resolved?.model.id).toBe("claude-sonnet-4-5");
	});

	it("reports an unresolvable definition model as no model rather than running the role", () => {
		const settings = Settings.isolated();
		settings.setModelRole("advisor", "openai/gpt-5.4");
		const broken: AgentDefinition = { ...reviewer, model: ["anthropic/does-not-exist"] };

		const resolved = resolveAdvisorEntryModel({
			override: null,
			definition: broken,
			settings,
			modelRegistry: registry,
		});

		expect(resolved).toBeUndefined();
	});

	it("falls back to the global advisor role for the built-in default advisor (no definition, no override)", () => {
		const settings = Settings.isolated();
		settings.setModelRole("advisor", "openai/gpt-5.4");

		const resolved = resolveAdvisorEntryModel({
			override: null,
			definition: undefined,
			settings,
			modelRegistry: registry,
		});

		expect(resolved?.model.id).toBe("gpt-5.4");
	});
});
