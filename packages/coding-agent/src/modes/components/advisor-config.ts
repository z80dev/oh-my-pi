/**
 * Fullscreen `/advisor configure` overlay: a two-pane per-driving-agent
 * advisor configurator. The left pane lists the global advisor-runtime
 * master switch, then the driving agents — `default` (the main session,
 * pinned on top) plus every discovered agent definition; the right pane
 * configures which advisors observe the agent selected on the left: the
 * built-in `default` advisor, one checkbox row per other agent definition,
 * and the Save/Close actions. The master-switch row itself renders an empty
 * right pane — it configures nothing per driving agent.
 *
 * It paints the entire alternate screen from row 0 (so SGR mouse rows index
 * directly into the rendered frame) using the shared {@link ./overlay-box} chrome.
 *
 * Both panes are backed by {@link SelectList}; Tab/←/→ switch pane focus.
 * Toggling mutates the in-memory rosters; "Save & apply" persists the master
 * switch and the main-session roster to `advisor.enabled`/`advisor.agents`,
 * writes changed agent `advisors:` frontmatter (shadow-copying into the user
 * agent dir when the original file isn't writable), and rebuilds the live
 * advisors via the host `save` callback. Closing with staged changes (Esc or
 * the Close row) saves them first; Ctrl+C closes without saving.
 *
 * Each checked advisor entry gains a `model` row that overrides that entry's
 * model for this driving agent only — the built-in default advisor included,
 * so its model is set per driving agent (persisted into the `default` roster
 * entry, never a global setting). Named advisors keep their own definition's
 * model unless overridden here.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import {
	type Component,
	type MouseRoutable,
	routeSgrMouseInput,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { resolveAdvisorEntryModel } from "../../config/model-resolver";
import { DEFAULT_MODEL_ROLE_ALIAS, formatModelRoleAlias, getKnownRoleIds } from "../../config/model-roles";
import type { Settings } from "../../config/settings";
import type { PerAdvisorStat } from "../../session/agent-session";
import { writeAgentFrontmatter } from "../../task/agents";
import type { AdvisorRoster, AgentDefinition, AgentSource } from "../../task/types";
import { getSelectListTheme, theme } from "../theme/theme";
import {
	buildBrowserItems,
	ModelBrowser,
	type ModelBrowserItem,
	resolveRoleAssignments,
	sortModelItems,
} from "./model-browser";
import { bottomBorder, dividerSplit, row, splitBodyWidth, splitRow, topBorderSplit } from "./overlay-box";
import { resolveSegmentPalette } from "./segment-track";

/** Host callbacks: live-runtime effects (and the status line) flow through these. */
export interface AdvisorAgentsPickerCallbacks {
	/** Persist the master switch + main-session roster and rebuild the live advisors. */
	save: (selection: { enabled: boolean; agents: AdvisorRoster }) => Promise<void> | void;
	/** Tear down the overlay and restore the editor. */
	close: () => void;
	requestRender: () => void;
	/** Surface a transient status/warning line to the user. */
	notify: (message: string) => void;
	/** Live advisor usage stats; kept for callers that surface them elsewhere. */
	getAdvisorStats?: () => PerAdvisorStat[];
}

export interface AdvisorAgentsPickerDeps {
	settings: Settings;
	/** The discovered agent roster; displayed (and persisted) in discovery order. */
	agents: readonly AgentDefinition[];
	/** Models available to advisors; drive the per-entry model pickers. */
	availableModels: Model<Api>[];
	/** User agent dir; edited agent files are shadow-copied here when unwritable. */
	userAgentsDir: string;
}

const SOURCE_LABEL: Record<AgentSource, string> = {
	project: "Project",
	user: "User",
	bundled: "Bundled",
};

/** Reserved name of the built-in default advisor (a definition named `default` wins at runtime). */
const DEFAULT_ADVISOR_NAME = "default";
/** Driving-agent key of the main session in the left pane. */
const MAIN_KEY = "__main";
const ENABLED_ACTION = "__enabled";
/** Prefix of right-pane model-override rows; the full value encodes the advisor name. */
const MODEL_ACTION_PREFIX = "__model:";
const SAVE_ACTION = "__save";
const CLOSE_ACTION = "__close";
/** Virtual picker row that clears an entry's override back to auto-selection. */
const ADVISOR_AUTO_SELECTOR = "auto";

const PREVIEW_WIDTH = 60;

/** First line of a description, truncated to the preview column width. */
function previewLine(text: string | undefined): string {
	if (!text?.trim()) return "";
	const first = text.trim().split("\n", 1)[0] ?? "";
	return first.length > PREVIEW_WIDTH ? `${first.slice(0, PREVIEW_WIDTH - 1)}…` : first;
}

/**
 * Convert a persisted roster record into a working map, dropping names that
 * are no longer known so save writes a self-healing list.
 */
function rosterMap(roster: AdvisorRoster | undefined, known: (name: string) => boolean): Map<string, string | null> {
	const map = new Map<string, string | null>();
	if (!roster) return map;
	for (const [name, override] of Object.entries(roster)) {
		if (!known(name)) continue;
		map.set(name, typeof override === "string" && override.trim() ? override.trim() : null);
	}
	return map;
}

/**
 * Shallow equality for roster records (name → model override). Used to tell
 * real edits apart from toggled-then-reverted ones; key order is fixed by
 * the record builder, so entry comparison is enough.
 */
function rosterRecordsEqual(a: AdvisorRoster, b: AdvisorRoster | undefined): boolean {
	if (b === undefined) return Object.keys(a).length === 0;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every(key => b[key] === a[key]);
}

/**
 * Fullscreen two-pane advisor configurator. Implements {@link Component}
 * directly (rather than extending Container) so it owns the whole frame and
 * the mouse geometry needed to make every row clickable.
 */
export class AdvisorAgentsPickerComponent implements Component {
	#settings: Settings;
	#agents: readonly AgentDefinition[];
	#agentByName: Map<string, AgentDefinition>;
	#availableModels: Model<Api>[];
	#userAgentsDir: string;
	#cb: AdvisorAgentsPickerCallbacks;
	#maxVisible: number;

	/** Master runtime switch (`advisor.enabled`); the left pane's first row. */
	#masterEnabled: boolean;
	/** Left-pane cursor sits on the master-switch row: the right pane renders empty. */
	#masterSelected: boolean;
	/**
	 * Advisors per driving agent, keyed by `"__main"` or the agent name:
	 * advisor name → model override (`null` = no override, the advisor's own
	 * model applies). A key's presence is roster membership.
	 */
	#rosters: Map<string, Map<string, string | null>>;
	/** Agent names whose `advisors` frontmatter changed and needs a write on save. */
	#dirtyAgents: Set<string>;
	/** Master-switch/main-roster changes are unsaved (drives the title marker). */
	#dirtyMain = false;
	/**
	 * Persisted state captured at construction and advanced after every save.
	 * Dirty flags are recomputed against it so a toggled-then-reverted edit
	 * counts as clean — close auto-saves, and a net-no-op "save" would still
	 * rewrite settings and shadow-copy bundled agent definitions into the
	 * user agents dir.
	 */
	#baseline = { masterEnabled: false, rosters: new Map<string, AdvisorRoster>() };
	/** Tail of the save queue (rejection-swallowing link); new saves chain behind it. */
	#saveInFlight: Promise<void> | undefined;
	/** True while the right pane picks a roster entry's model. */
	#advisorModelMode = false;
	/** The roster entry whose model is being picked. */
	#advisorModelTarget: string | undefined;
	/** The model browser shown while {@link #advisorModelMode} is active. */
	#advisorBrowser: ModelBrowser;

	/** Driving agent selected in the left pane: `"__main"` or an agent name. */
	#selectedDriving = MAIN_KEY;
	#focus: "left" | "right" = "left";
	#leftList: SelectList;
	#rightList: SelectList;
	/** Cursor indexes, restored after every rebuild so toggles don't jump. */
	#leftCursor = 0;
	#rightCursor = 0;

	// Frame geometry from the last render (the frame paints from screen row 0,
	// so SGR `event.row`/`event.col` — already 0-based — index it directly).
	#bodyRowStart = 0;
	#dividerCol = 0;

	constructor(deps: AdvisorAgentsPickerDeps, callbacks: AdvisorAgentsPickerCallbacks) {
		this.#settings = deps.settings;
		this.#agents = deps.agents;
		this.#agentByName = new Map(deps.agents.map(agent => [agent.name, agent]));
		this.#availableModels = deps.availableModels;
		this.#userAgentsDir = deps.userAgentsDir;
		this.#cb = callbacks;
		this.#maxVisible = Math.max(3, (process.stdout.rows || 40) - 4);
		this.#advisorBrowser = new ModelBrowser(this.#settings);
		this.#advisorBrowser.onActivate = item => this.#onAdvisorModelPicked(item);
		this.#advisorBrowser.onCancel = () => this.#exitAdvisorModelMode();

		this.#masterEnabled = this.#settings.get("advisor.enabled");
		// The left cursor starts on the master-switch row (#leftCursor = 0), so
		// the right pane is blank until a driving agent is selected.
		this.#masterSelected = true;
		// Roster state starts from the persisted settings/frontmatter; names
		// that are no longer known ("default" or a discovered agent) are dropped
		// so save writes a self-healing list.
		const known = (name: string): boolean => name === DEFAULT_ADVISOR_NAME || this.#agentByName.has(name);
		this.#rosters = new Map([[MAIN_KEY, rosterMap(this.#settings.get("advisor.agents"), known)]]);
		for (const agent of this.#agents) {
			this.#rosters.set(agent.name, rosterMap(agent.advisors, known));
		}
		this.#dirtyAgents = new Set();
		this.#captureBaseline();
		this.#leftList = this.#buildLeft();
		this.#rightList = this.#buildRight();
	}

	/** Snapshot the current master switch + roster records as the clean state. */
	#captureBaseline(): void {
		this.#baseline.masterEnabled = this.#masterEnabled;
		this.#baseline.rosters.clear();
		for (const key of this.#rosters.keys()) {
			this.#baseline.rosters.set(key, this.#rosterRecord(key));
		}
	}

	/** Recompute dirty flags against the baseline; call after every roster/master mutation. */
	#refreshDirty(): void {
		this.#dirtyMain =
			this.#masterEnabled !== this.#baseline.masterEnabled ||
			!rosterRecordsEqual(this.#rosterRecord(MAIN_KEY), this.#baseline.rosters.get(MAIN_KEY));
		this.#dirtyAgents.clear();
		for (const agent of this.#agents) {
			if (!rosterRecordsEqual(this.#rosterRecord(agent.name), this.#baseline.rosters.get(agent.name))) {
				this.#dirtyAgents.add(agent.name);
			}
		}
	}

	// ───────────────────────────── render ─────────────────────────────

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows || 40);
		const bodyRows = Math.max(3, height - 4);
		const drivingLabel = this.#selectedDriving === MAIN_KEY ? "default (main session)" : this.#selectedDriving;
		// The marker precedes the label: the title truncates to the sidebar
		// width, so a trailing marker would vanish on long agent names.
		const title = `Advisor configure${this.#dirtyMain || this.#dirtyAgents.size > 0 ? "  ● unsaved" : ""} · ${drivingLabel}`;
		const out: string[] = [];

		const sidebarWidth = Math.max(22, Math.min(42, Math.floor(width * 0.34)));
		this.#dividerCol = sidebarWidth + 3;
		const bodyWidth = splitBodyWidth(width, sidebarWidth);
		const sidebar = this.#leftList.render(sidebarWidth);
		// The master switch configures nothing per driving agent: its row
		// renders an empty right pane (splitRow pads missing lines with blanks).
		const body = this.#masterSelected
			? []
			: this.#advisorModelMode
				? this.#renderAdvisorModelBody(bodyWidth, bodyRows)
				: this.#rightList.render(bodyWidth);
		out.push(topBorderSplit(width, title, sidebarWidth));
		this.#bodyRowStart = out.length;
		for (let i = 0; i < bodyRows; i++) {
			out.push(splitRow(sidebar[i] ?? "", body[i] ?? "", width, sidebarWidth));
		}
		out.push(dividerSplit(width, sidebarWidth));

		out.push(row(theme.fg("dim", this.#footerHint()), width));
		out.push(bottomBorder(width));
		return out;
	}

	// ───────────────────────────── input ─────────────────────────────

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => this.#routeMouseEvent(event));
			return;
		}
		if (this.#advisorModelMode) {
			// The model picker is modal: the browser owns every key — Ctrl+C
			// included, where (like Esc) it clears the query or backs out to
			// the roster rather than closing the overlay. Tab, pane switches,
			// and roster actions are inert while picking.
			this.#advisorBrowser.handleInput(data);
			return;
		}
		// Ctrl+C is the picker's only discard affordance: close without
		// saving, even with staged changes. SelectList binds both Escape and
		// Ctrl+C to its cancel (which now auto-saves), so intercept before
		// delegating to the lists.
		if (data === "\x03") {
			this.#cb.close();
			return;
		}
		// Pane switching is intercepted before delegation: SelectList never
		// consumes Tab or the horizontal arrows.
		if (data === "\t") {
			this.#setFocus(this.#focus === "left" ? "right" : "left");
			return;
		}
		if (data === "\x1b[C") {
			this.#setFocus("right");
			return;
		}
		if (data === "\x1b[D") {
			this.#setFocus("left");
			return;
		}
		(this.#focus === "left" ? this.#leftList : this.#rightList).handleInput(data);
	}

	#routeMouseEvent(event: SgrMouseEvent): boolean {
		// Left of the divider routes into the driving-agent list, right of it
		// into the advisor checklist; the pane under the pointer gains focus.
		// SelectList.routeMouse handles wheel/click/hover on its own.
		const left = event.col < this.#dividerCol;
		// The blank pane must not route clicks/wheel into the stale right list.
		if (!left && this.#masterSelected) return true;
		if (this.#advisorModelMode) {
			// Only the browser pane is interactive while picking; the header
			// row above it and the whole left pane are inert.
			if (left) return true;
			this.#advisorBrowser.routeMouse(event, event.row - this.#bodyRowStart - 1);
			return true;
		}
		this.#setFocus(left ? "left" : "right");
		const el = (left ? this.#leftList : this.#rightList) as Partial<MouseRoutable>;
		if (typeof el.routeMouse === "function") {
			el.routeMouse(event, event.row - this.#bodyRowStart, event.col);
			return true;
		}
		return false;
	}

	// ───────────────────────────── state ─────────────────────────────

	#setFocus(focus: "left" | "right"): void {
		if (this.#focus === focus) return;
		// Nothing to focus while the master switch blanks the right pane.
		if (focus === "right" && this.#masterSelected) return;
		this.#focus = focus;
		this.#cb.requestRender();
	}

	#currentRoster(): Map<string, string | null> {
		let roster = this.#rosters.get(this.#selectedDriving);
		if (!roster) {
			roster = new Map();
			this.#rosters.set(this.#selectedDriving, roster);
		}
		return roster;
	}

	/** The persisted roster record for one driving agent, `"default"` first then discovery order. */
	#rosterRecord(key: string): AdvisorRoster {
		const map = this.#rosters.get(key);
		if (!map) return {};
		const record: AdvisorRoster = {};
		if (map.has(DEFAULT_ADVISOR_NAME)) record[DEFAULT_ADVISOR_NAME] = map.get(DEFAULT_ADVISOR_NAME) ?? null;
		for (const agent of this.#agents) {
			if (!map.has(agent.name)) continue;
			record[agent.name] = map.get(agent.name) ?? null;
		}
		return record;
	}

	#footerHint(): string {
		if (this.#advisorModelMode) {
			return "↑↓ move · Enter assign · type to search · Esc back";
		}
		const esc = this.#dirtyMain || this.#dirtyAgents.size > 0 ? "Esc save & close · ^C discard" : "Esc close";
		const base =
			this.#focus === "left"
				? this.#masterSelected
					? `↑↓ move · Enter toggle · ${esc}`
					: `↑↓ move · Enter toggle/configure · → advisors · Tab switch pane · ${esc}`
				: `↑↓ move · Enter toggle · ←/Tab back · ${esc}`;
		// The main session with an empty roster and the master switch on still
		// runs the built-in default advisor at runtime — name it so the
		// fallback isn't a surprise.
		if (
			!this.#masterSelected &&
			this.#selectedDriving === MAIN_KEY &&
			this.#currentRoster().size === 0 &&
			this.#masterEnabled
		) {
			const model = this.#resolvedAdvisorModel(DEFAULT_ADVISOR_NAME);
			const label = model ? ` (${model.provider}/${model.id})` : "";
			return `${base} · empty roster → built-in default advisor${label}`;
		}
		return base;
	}

	// ───────────────────────────── left pane ─────────────────────────

	#buildLeft(): SelectList {
		const items: SelectItem[] = [
			{
				value: ENABLED_ACTION,
				label: `${this.#masterEnabled ? "[x]" : "[ ]"} Advisor runtime ${theme.fg("dim", "(global)")}`,
				description: "Global switch for every advisor runtime — same as /advisor on|off",
			},
			{
				value: MAIN_KEY,
				label: `default ${theme.fg("dim", "(main session)")}`,
				description: "Advisors observing the main session (advisor.agents setting)",
			},
			...this.#agents.map(agent => ({
				value: agent.name,
				label: `${agent.name} ${theme.fg("dim", `[${SOURCE_LABEL[agent.source]}]`)}`,
				description: previewLine(agent.description),
			})),
		];
		this.#leftCursor = Math.min(this.#leftCursor, Math.max(0, items.length - 1));
		const list = new SelectList(items, this.#maxVisible, getSelectListTheme());
		list.setSelectedIndex(this.#leftCursor);
		list.onSelectionChange = item => {
			this.#leftCursor = Math.max(
				0,
				items.findIndex(i => i.value === item.value),
			);
			// The master-switch row is an action, not a driving agent: it blanks
			// the right pane; the last driving-agent selection is kept so the
			// roster returns when the cursor moves off the switch.
			this.#masterSelected = item.value === ENABLED_ACTION;
			if (item.value !== ENABLED_ACTION && item.value !== this.#selectedDriving) {
				this.#selectedDriving = item.value;
				this.#rightList = this.#buildRight();
			}
			this.#cb.requestRender();
		};
		list.onSelect = item => {
			if (item.value === ENABLED_ACTION) {
				this.#masterEnabled = !this.#masterEnabled;
				this.#refreshDirty();
				this.#leftList = this.#buildLeft();
				this.#cb.requestRender();
				return;
			}
			this.#setFocus("right");
		};
		list.onCancel = () => this.#requestClose();
		return list;
	}

	// ───────────────────────────── right pane ────────────────────────

	#buildRight(): SelectList {
		const items = this.#rightItems();
		this.#rightCursor = Math.min(this.#rightCursor, Math.max(0, items.length - 1));
		const list = new SelectList(items, this.#maxVisible, getSelectListTheme());
		list.setSelectedIndex(this.#rightCursor);
		list.onSelectionChange = item => {
			this.#rightCursor = Math.max(
				0,
				items.findIndex(i => i.value === item.value),
			);
			this.#cb.requestRender();
		};
		list.onSelect = item =>
			void this.#onRightSelect(item.value).catch(err => {
				this.#cb.notify(`Advisor picker: ${err instanceof Error ? err.message : String(err)}`);
			});
		list.onCancel = () => this.#requestClose();
		return list;
	}

	/** One checkbox row for an advisor entry, plus its model-override row when checked. */
	#entryItems(roster: Map<string, string | null>, name: string, label: string, description: string): SelectItem[] {
		const items: SelectItem[] = [
			{
				value: name,
				label: `${roster.has(name) ? "[x]" : "[ ]"} ${label}`,
				description,
			},
		];
		if (roster.has(name)) {
			items.push({
				value: `${MODEL_ACTION_PREFIX}${name}`,
				label: `model: ${theme.fg("dim", this.#advisorModelDisplay(name))}`,
				description:
					name === DEFAULT_ADVISOR_NAME
						? "Enter to pick a role or model for the built-in default advisor (auto = the advisor role)"
						: "Enter to override this advisor's model for this agent (auto = its own definition model)",
			});
		}
		return items;
	}

	#rightItems(): SelectItem[] {
		const roster = this.#currentRoster();
		const drivingName =
			this.#selectedDriving === MAIN_KEY ? undefined : this.#agentByName.get(this.#selectedDriving)?.name;
		const items: SelectItem[] = [];
		// A real agent definition named "default" wins over the built-in at
		// runtime; its own row below represents that name, so the built-in row
		// is omitted in that case.
		if (!this.#agentByName.has(DEFAULT_ADVISOR_NAME)) {
			items.push(
				...this.#entryItems(
					roster,
					DEFAULT_ADVISOR_NAME,
					"default",
					`Built-in baseline advisor · model: ${this.#entryModelLabel(DEFAULT_ADVISOR_NAME)} · tools: read, grep, glob`,
				),
			);
		}
		for (const agent of this.#agents) {
			if (agent.name === drivingName) continue;
			items.push(
				...this.#entryItems(
					roster,
					agent.name,
					`${agent.name} ${theme.fg("dim", `[${SOURCE_LABEL[agent.source]}]`)}`,
					previewLine(agent.description),
				),
			);
		}
		items.push({ value: SAVE_ACTION, label: "Save & apply" });
		items.push({ value: CLOSE_ACTION, label: "Close" });
		return items;
	}

	/**
	 * Close the overlay, auto-saving staged changes first. The picker stages
	 * roster/model edits in memory; bailing out with Esc or the Close row must
	 * not silently drop them, so close runs the same save path as "Save &
	 * apply" whenever anything is dirty.
	 */
	#requestClose(): void {
		if (this.#dirtyMain || this.#dirtyAgents.size > 0) {
			void this.#save({ skipIfClean: true }).catch(err => {
				this.#cb.notify(`Advisor picker: ${err instanceof Error ? err.message : String(err)}`);
			});
		}
		this.#cb.close();
	}

	async #onRightSelect(value: string): Promise<void> {
		if (value === SAVE_ACTION) {
			await this.#save();
			return;
		}
		if (value === CLOSE_ACTION) {
			this.#requestClose();
			return;
		}
		if (value.startsWith(MODEL_ACTION_PREFIX)) {
			this.#enterAdvisorModelMode(value.slice(MODEL_ACTION_PREFIX.length));
			return;
		}
		const roster = this.#currentRoster();
		if (roster.has(value)) roster.delete(value);
		else roster.set(value, null);
		this.#refreshDirty();
		this.#rightList = this.#buildRight();
		this.#cb.requestRender();
	}

	// ───────────────────── per-entry model picker ─────────────────────

	/** The override for one advisor entry of the selected driving agent, or undefined when not in the roster. */
	#advisorOverride(advisor: string): string | null | undefined {
		return this.#currentRoster().get(advisor);
	}

	/**
	 * The currently effective model for one advisor entry: the driving
	 * agent's override wins; else the advisor definition's own `model`;
	 * else the `advisor` role chain.
	 */
	#resolvedAdvisorModel(advisor: string): Model<Api> | undefined {
		return resolveAdvisorEntryModel({
			override: this.#advisorOverride(advisor),
			definition: this.#agentByName.get(advisor),
			settings: this.#settings,
			modelRegistry: { getAvailable: () => this.#availableModels },
		})?.model;
	}

	/** Description label for one entry's effective model. */
	#entryModelLabel(advisor: string): string {
		const model = this.#resolvedAdvisorModel(advisor);
		if (model) return `${model.provider}/${model.id}`;
		const override = this.#advisorOverride(advisor);
		if (override) return "no match";
		if (advisor === DEFAULT_ADVISOR_NAME) return "auto (slow chain)";
		return this.#agentByName.get(advisor)?.model?.length ? "no match" : "auto (own model)";
	}

	/** Value shown on an entry's model row: its override, or `auto`. */
	#advisorModelDisplay(advisor: string): string {
		const override = this.#advisorOverride(advisor);
		if (!override) return "auto";
		return override === DEFAULT_MODEL_ROLE_ALIAS ? formatModelRoleAlias("default") : override;
	}

	/** Selector to mark/preselect in the picker: the entry's override, or the auto row. */
	#advisorCurrentSelector(advisor: string): string {
		const override = this.#advisorOverride(advisor);
		if (!override) return ADVISOR_AUTO_SELECTOR;
		return override === DEFAULT_MODEL_ROLE_ALIAS ? formatModelRoleAlias("default") : override;
	}

	#enterAdvisorModelMode(advisor: string): void {
		this.#advisorModelTarget = advisor;
		this.#advisorModelMode = true;
		this.#focus = "right";
		this.#refreshAdvisorModelBrowser();
		this.#cb.requestRender();
	}

	#exitAdvisorModelMode(): void {
		this.#advisorModelMode = false;
		this.#advisorModelTarget = undefined;
		this.#rightList = this.#buildRight();
		this.#cb.requestRender();
	}

	/** Rebuild the picker rows: auto, one row per resolvable role, then the model catalog. */
	#refreshAdvisorModelBrowser(): void {
		const target = this.#advisorModelTarget ?? DEFAULT_ADVISOR_NAME;
		const assignments = resolveRoleAssignments(this.#settings, this.#availableModels, this.#availableModels);
		const roleNames = getKnownRoleIds(this.#settings).filter(role => role !== "advisor");
		const palette = resolveSegmentPalette(roleNames.length);
		const items: ModelBrowserItem[] = [];
		// The auto row carries the entry's own resolution (its definition
		// `model`, or the `advisor` role for the built-in default) so its
		// detail line shows what runs once the override is cleared. Without
		// a resolvable model it is omitted.
		const autoModel = resolveAdvisorEntryModel({
			override: null,
			definition: this.#agentByName.get(target),
			settings: this.#settings,
			modelRegistry: { getAvailable: () => this.#availableModels },
		});
		if (autoModel) {
			items.push({ provider: "", id: "auto", model: autoModel.model, selector: ADVISOR_AUTO_SELECTOR });
		}
		roleNames.forEach((role, index) => {
			const assignment = assignments[role];
			if (!assignment) return;
			items.push({
				provider: "",
				id: formatModelRoleAlias(role),
				model: assignment.model,
				selector: formatModelRoleAlias(role),
				labelColor: palette[index % palette.length],
			});
		});
		const models = buildBrowserItems(this.#availableModels);
		sortModelItems(models, { roles: assignments });
		items.push(...models);

		const storage = this.#settings.getStorage();
		this.#advisorBrowser.setRoles(assignments);
		this.#advisorBrowser.setMruOrder(storage?.getModelUsageOrder() ?? []);
		this.#advisorBrowser.setPerfStats(storage?.getModelPerf() ?? new Map());
		this.#advisorBrowser.setItems(items);
		this.#advisorBrowser.setCurrentSelector(this.#advisorCurrentSelector(target));
		this.#advisorBrowser.selectSelector(this.#advisorCurrentSelector(target));
	}

	/** Stage a picked role/model (or the auto row) as the target entry's override and return to the roster. */
	#onAdvisorModelPicked(item: ModelBrowserItem): void {
		const target = this.#advisorModelTarget;
		if (!target) {
			this.#exitAdvisorModelMode();
			return;
		}
		const value = item.selector === ADVISOR_AUTO_SELECTOR ? null : item.selector;
		const current = this.#currentRoster().get(target) ?? null;
		// `*` (DEFAULT_MODEL_ROLE_ALIAS) is shorthand for `@default`; treat them
		// as equal so re-picking the effective value stays a no-op.
		const normalize = (v: string | null): string | null =>
			v === DEFAULT_MODEL_ROLE_ALIAS ? formatModelRoleAlias("default") : v;
		if (normalize(value) !== normalize(current)) {
			this.#currentRoster().set(target, value);
			this.#refreshDirty();
		}
		this.#exitAdvisorModelMode();
	}

	/** Model-mode body: a dim header naming the target entry and current value, then the browser. */
	#renderAdvisorModelBody(width: number, rows: number): string[] {
		const lines: string[] = [];
		const target = this.#advisorModelTarget ?? DEFAULT_ADVISOR_NAME;
		const targetLabel = target === DEFAULT_ADVISOR_NAME ? "default advisor" : `${target} advisor`;
		lines.push(
			truncateToWidth(
				theme.fg("dim", ` ${targetLabel} model — current: ${this.#advisorModelDisplay(target)}`),
				width,
			),
		);
		this.#advisorBrowser.setMaxVisible(Math.max(1, rows - 6));
		this.#advisorBrowser.setFocused(true);
		lines.push(...this.#advisorBrowser.render(width));
		while (lines.length < rows) lines.push("");
		return lines;
	}

	// ───────────────────────────── save ──────────────────────────────

	/**
	 * Persist staged changes. Saves serialize rather than dedupe: an edit
	 * staged while a save is in flight (e.g. "Save & apply", then another
	 * model pick, then Esc) queues a follow-up run that persists the newer
	 * state — reusing the in-flight run would silently drop it.
	 */
	#save(options?: { skipIfClean?: boolean }): Promise<void> {
		const run = (this.#saveInFlight ?? Promise.resolve())
			.catch(() => {})
			.then(() => {
				// A close-queued save re-checks dirtiness at execution time: a
				// preceding run may already have persisted everything, and a
				// redundant run would tear down and rebuild the live advisor
				// runtime (via the host save callback) for nothing.
				if (options?.skipIfClean && !this.#dirtyMain && this.#dirtyAgents.size === 0) return;
				return this.#doSave();
			});
		// The field tracks the chain tail without its caller-facing rejection:
		// a failed run must not poison the queue for later saves.
		this.#saveInFlight = run.catch(() => {});
		return run;
	}

	async #doSave(): Promise<void> {
		// Snapshot everything this run persists up front: the overlay can keep
		// mutating rosters behind an in-flight save (Save & apply does not
		// close the picker), and the rebaseline below must record what this
		// run wrote — not whatever the live state drifted to mid-flight.
		const savedMaster = this.#masterEnabled;
		const mainRoster = this.#rosterRecord(MAIN_KEY);
		this.#settings.set("advisor.enabled", savedMaster);
		this.#settings.set("advisor.agents", mainRoster);

		// Persist frontmatter for every agent whose roster changed. A shadow
		// copy (result.shadowed) means the local definition now points at the
		// written file; mutate it so reopening reflects reality.
		const failed: string[] = [];
		const savedRosters = new Map<string, AdvisorRoster>();
		for (const name of [...this.#dirtyAgents]) {
			const agent = this.#agentByName.get(name);
			if (!agent) continue;
			const roster = this.#rosterRecord(name);
			try {
				const result = await writeAgentFrontmatter(agent, { advisors: roster }, this.#userAgentsDir);
				agent.advisors = Object.keys(roster).length > 0 ? roster : undefined;
				if (result.shadowed) {
					agent.filePath = result.filePath;
					agent.source = "user";
				}
				savedRosters.set(name, roster);
			} catch {
				failed.push(name);
			}
		}
		if (failed.length > 0) this.#cb.notify(`Failed to write advisors for: ${failed.join(", ")}`);

		await this.#cb.save({ enabled: savedMaster, agents: mainRoster });

		// Re-baseline what this run persisted: settings and the main roster
		// always landed; agents whose frontmatter write failed stay dirty so
		// the marker and the next save retry them.
		this.#baseline.masterEnabled = savedMaster;
		this.#baseline.rosters.set(MAIN_KEY, mainRoster);
		for (const [name, roster] of savedRosters) {
			this.#baseline.rosters.set(name, roster);
		}
		this.#refreshDirty();
		this.#leftList = this.#buildLeft();
		this.#rightList = this.#buildRight();
		this.#cb.requestRender();
	}
}
