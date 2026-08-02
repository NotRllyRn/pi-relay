import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { RelayController } from "./pi.js";
import { earliestFutureReset, selectProfile } from "./select.js";
import type { Policy, RelayProfile } from "./types.js";
import { dashboard } from "./ui.js";
import { limitingRemaining } from "./usage.js";

const POLICIES = new Set<Policy>([
	"smart-reset",
	"most-available",
	"priority-order",
]);

export function registerRelayCommand(
	pi: ExtensionAPI,
	controller: RelayController,
): void {
	pi.registerCommand("relay", {
		description: "Manage Codex Relay accounts, policy, and quota wait",
		handler: async (input, context) => {
			try {
				await handle(input.trim(), context, controller);
			} catch (error) {
				output(
					context,
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});
}

async function handle(
	input: string,
	context: ExtensionCommandContext,
	controller: RelayController,
): Promise<void> {
	const [command, accountArg, ...rest] = input.split(/\s+/).filter(Boolean);
	if (!command) {
		await showStatus(context, controller);
		if (context.hasUI) await showMenu(context, controller);
		return;
	}
	if (command === "status") return showStatus(context, controller);
	if (command === "add") {
		if (!context.hasUI)
			throw new Error("Run /login openai-codex in interactive mode");
		context.ui.setEditorText("/login openai-codex");
		return output(
			context,
			"Run the prepared /login command to enter masked tokens",
		);
	}
	if (command === "logs")
		return output(context, `Relay log: ${controller.log.path}`);
	if (command === "policy") {
		if (!accountArg)
			return output(
				context,
				`Relay policy: ${(await controller.vault.read()).settings.policy}`,
			);
		if (!POLICIES.has(accountArg as Policy))
			throw new Error(`Unknown policy: ${accountArg}`);
		await controller.vault.change((state) => {
			state.settings.policy = accountArg as Policy;
		});
		return output(context, `Relay policy: ${accountArg}`);
	}
	if (command === "refresh") {
		const profiles =
			accountArg && accountArg !== "all"
				? [await resolveAccount(controller, accountArg)]
				: await controller.vault.listProfiles();
		const results = await Promise.allSettled(
			profiles.map((profile) => controller.refreshProfile(profile, true)),
		);
		const failures = results.filter(
			(result) => result.status === "rejected",
		).length;
		return output(
			context,
			`Refreshed ${profiles.length - failures}/${profiles.length} accounts${failures ? `; ${failures} failed` : ""}`,
		);
	}
	if (command === "wait")
		return waitCommand(accountArg, rest, context, controller);
	if (command === "unpin") {
		const next = await controller.unpin();
		return output(context, `Unpinned; next account: ${next?.label ?? "none"}`);
	}
	if (!accountArg) throw new Error(`Account required for relay ${command}`);
	const profile = await resolveAccount(controller, accountArg);
	switch (command) {
		case "use":
			controller.pin(profile);
			return output(context, `Pinned ${profile.label}`);
		case "prioritize":
			controller.prioritize(profile.id);
			return output(context, `Prioritized ${profile.label}`);
		case "skip": {
			await controller.vault.update(profile.id, (value) => {
				value.skippedUntil =
					earliestFutureReset(value) ?? Number.MAX_SAFE_INTEGER;
			});
			return output(
				context,
				`Skipped ${profile.label}${earliestFutureReset(profile) ? " until reset" : " until cleared"}`,
			);
		}
		case "disable":
			await controller.vault.update(profile.id, (value) => {
				value.enabled = false;
			});
			controller.clearProfileReferences(profile.id);
			return output(context, `Disabled ${profile.label}`);
		case "enable":
			await controller.vault.update(profile.id, (value) => {
				value.enabled = true;
				delete value.skippedUntil;
				delete value.exhaustedUntil;
				delete value.cooldownUntil;
			});
			return output(context, `Enabled ${profile.label}`);
		case "rename": {
			const label = rest.join(" ").trim();
			if (!label) throw new Error("New label required");
			await controller.vault.update(profile.id, (value) => {
				value.label = label;
			});
			return output(context, `Renamed ${profile.label} to ${label}`);
		}
		case "delete":
		case "remove":
			if (
				context.mode === "tui" &&
				!(await context.ui.confirm("Remove Relay account?", profile.label))
			)
				return;
			await controller.vault.remove(profile.id);
			controller.clearProfileReferences(profile.id);
			return output(context, `Removed ${profile.label}`);
		default:
			throw new Error(`Unknown Relay command: ${command}`);
	}
}

async function showMenu(
	context: ExtensionCommandContext,
	controller: RelayController,
): Promise<void> {
	const actions = [
		"Add account",
		"Use / pin account",
		...(controller.pinnedId() ? ["Unpin account"] : []),
		"Rename account",
		"Delete account",
		"Enable / disable account",
		"Prioritize account",
		"Skip account until reset",
		"Refresh usage",
		"Change policy",
		"Quota Wait",
		"Show log path",
	];
	const action = await context.ui.select("Pi Relay", actions);
	if (!action) return;
	if (action === "Add account") return handle("add", context, controller);
	if (action === "Unpin account") return handle("unpin", context, controller);
	if (action === "Show log path") return handle("logs", context, controller);
	if (action === "Change policy") {
		const policy = await context.ui.select("Relay policy", [...POLICIES]);
		if (policy) await handle(`policy ${policy}`, context, controller);
		return;
	}
	if (action === "Quota Wait") return waitMenu(context, controller);
	if (action === "Refresh usage") {
		const profile = await selectAccount(
			context,
			controller,
			"Refresh usage",
			true,
		);
		if (profile !== undefined)
			await handle(`refresh ${profile?.id ?? "all"}`, context, controller);
		return;
	}
	const profile = await selectAccount(context, controller, action);
	if (!profile) return;
	switch (action) {
		case "Use / pin account":
			return handle(`use ${profile.id}`, context, controller);
		case "Rename account": {
			const label = await context.ui.input("New account name", profile.label);
			if (label?.trim())
				await handle(
					`rename ${profile.id} ${label.trim()}`,
					context,
					controller,
				);
			return;
		}
		case "Delete account":
			return handle(`delete ${profile.id}`, context, controller);
		case "Enable / disable account":
			return handle(
				`${profile.enabled ? "disable" : "enable"} ${profile.id}`,
				context,
				controller,
			);
		case "Prioritize account":
			return handle(`prioritize ${profile.id}`, context, controller);
		case "Skip account until reset":
			return handle(`skip ${profile.id}`, context, controller);
	}
}

async function selectAccount(
	context: ExtensionCommandContext,
	controller: RelayController,
	title: string,
	includeAll = false,
): Promise<RelayProfile | null | undefined> {
	const profiles = await controller.vault.listProfiles();
	const choices = [
		...(includeAll ? ["All accounts"] : []),
		...profiles.map(
			(profile) => `${profile.label} · ${profile.id.slice(0, 8)}`,
		),
	];
	if (!choices.length)
		throw new Error("No Relay accounts; choose Add account first");
	const choice = await context.ui.select(title, choices);
	if (!choice) return undefined;
	if (choice === "All accounts") return null;
	return profiles[choices.indexOf(choice) - (includeAll ? 1 : 0)];
}

async function waitMenu(
	context: ExtensionCommandContext,
	controller: RelayController,
): Promise<void> {
	const action = await context.ui.select("Quota Wait", [
		"Status",
		"Pause",
		"Resume",
		"Cancel",
		"Override account",
	]);
	if (!action) return;
	if (action !== "Override account")
		return waitCommand(action.toLowerCase(), [], context, controller);
	const profile = await selectAccount(
		context,
		controller,
		"Override with account",
	);
	if (profile) await waitCommand("override", [profile.id], context, controller);
}

async function showStatus(
	context: ExtensionCommandContext,
	controller: RelayController,
): Promise<void> {
	const profiles = await controller.freshProfiles();
	const state = await controller.vault.read();
	const next = selectProfile(
		profiles,
		state.settings.policy,
		controller.overrides(),
		Date.now(),
		new Set(),
		state.settings.priorityOrder,
	).profile;
	output(
		context,
		dashboard(
			state,
			controller.pinnedId() ?? next?.id ?? controller.activeId(),
			next?.id,
		),
	);
}

async function waitCommand(
	action: string | undefined,
	rest: string[],
	context: ExtensionCommandContext,
	controller: RelayController,
): Promise<void> {
	switch (action ?? "status") {
		case "status":
			return output(context, `Quota Wait: ${controller.wait.state}`);
		case "cancel":
			controller.cancelWait();
			return output(context, "Quota Wait cancelled");
		case "pause":
			controller.pauseWait();
			return output(context, "Quota Wait paused");
		case "resume":
			return output(
				context,
				(await controller.resumeWait())
					? "Quota Wait resumed"
					: "No resumable quota reset found",
			);
		case "override": {
			const profile = await resolveAccount(controller, rest[0] ?? "");
			if (limitingRemaining(profile.quota) === 0) {
				if (
					context.mode !== "tui" ||
					!(await context.ui.confirm(
						"Account reports zero quota",
						`Override with ${profile.label}?`,
					))
				)
					throw new Error("Override cancelled: account has zero quota");
			}
			controller.overrideWait(profile);
			return output(context, `Quota Wait overridden with ${profile.label}`);
		}
		default:
			throw new Error(`Unknown wait action: ${action}`);
	}
}

export async function resolveAccount(
	controller: RelayController,
	argument: string,
): Promise<RelayProfile> {
	if (!argument) throw new Error("Account required");
	const profiles = await controller.vault.listProfiles();
	const exactId = profiles.find((profile) => profile.id === argument);
	if (exactId) return exactId;
	const exactLabel = profiles.find(
		(profile) => profile.label.toLowerCase() === argument.toLowerCase(),
	);
	if (exactLabel) return exactLabel;
	const matches = profiles.filter((profile) =>
		profile.label.toLowerCase().startsWith(argument.toLowerCase()),
	);
	if (matches.length === 1) return matches[0]!;
	if (matches.length > 1)
		throw new Error(
			`Ambiguous account: ${matches.map((profile) => profile.label).join(", ")}`,
		);
	throw new Error(`Account not found: ${argument}`);
}

const output = (
	context: ExtensionCommandContext,
	text: string,
	level: "info" | "error" = "info",
) => {
	if (context.hasUI) context.ui.notify(text, level);
	else if (context.mode === "print") console.log(text);
	else console.error(text);
};
