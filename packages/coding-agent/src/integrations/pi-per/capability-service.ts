import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import { PluginManager } from "../../extensibility/plugins";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import { setMcpServerEnabled } from "../../mcp/config-writer";
import { loadAllExtensions } from "../../modes/components/extensions/state-manager";
import type { RpcCapabilitySetting } from "../../modes/rpc/rpc-types";
import type { AgentSession } from "../../session/agent-session";
import { discoverAgents } from "../../task/discovery";

interface CapabilityEntry {
	setting: RpcCapabilitySetting;
	kind: "agent" | "mcp" | "disabled-extension" | "npm-plugin" | "marketplace-plugin";
	name?: string;
	settingId?: string;
	sourcePath?: string;
	pluginId?: string;
	scope?: "user" | "project";
}

export class PiPerCapabilityService {
	readonly #session: Pick<AgentSession, "settings" | "sessionManager">;
	#disabledAgents: Set<string> | undefined;
	#disabledAgentsCwd: string | undefined;

	constructor(session: Pick<AgentSession, "settings" | "sessionManager">) {
		this.#session = session;
	}

	async list(): Promise<RpcCapabilitySetting[]> {
		return (await this.#inventory()).map(entry => entry.setting);
	}

	async setEnabled(capabilityId: string, enabled: boolean): Promise<RpcCapabilitySetting[]> {
		if (typeof capabilityId !== "string" || typeof enabled !== "boolean")
			throw new Error("Invalid capability setting request");
		const entry = (await this.#inventory()).find(candidate => candidate.setting.id === capabilityId);
		if (!entry) throw new Error("Unknown capability setting");
		const cwd = this.#session.sessionManager.getCwd();
		switch (entry.kind) {
			case "agent":
				await this.#updateDisabled("task.disabledAgents", entry.name ?? "", enabled);
				break;
			case "mcp":
				await setMcpServerEnabled({
					userPath: getMCPConfigPath("user", cwd),
					projectPath: getMCPConfigPath("project", cwd),
					sourcePath: entry.sourcePath,
					name: entry.name ?? "",
					enabled,
				});
				if (enabled) await this.#updateDisabled("disabledExtensions", `mcp:${entry.name}`, true);
				break;
			case "disabled-extension":
				await this.#updateDisabled("disabledExtensions", entry.settingId ?? "", enabled);
				break;
			case "npm-plugin":
				await new PluginManager(cwd).setEnabled(entry.name ?? "", enabled);
				break;
			case "marketplace-plugin":
				await (await this.#marketplace(cwd)).setPluginEnabled(entry.pluginId ?? "", enabled, entry.scope ?? "user");
				break;
		}
		return this.list();
	}

	async #inventory(): Promise<CapabilityEntry[]> {
		const cwd = this.#session.sessionManager.getCwd();
		const disabledExtensionIds = this.#stringSettings("disabledExtensions");
		const marketplace = await this.#marketplace(cwd);
		const [{ agents }, extensions, npmPlugins, marketplacePlugins] = await Promise.all([
			discoverAgents(cwd),
			loadAllExtensions(cwd, disabledExtensionIds),
			new PluginManager(cwd).list(),
			marketplace.listInstalledPlugins(),
		]);
		const entries: CapabilityEntry[] = [];
		const disabledAgents = this.#disabledAgentsFor(cwd);
		for (const agent of agents) {
			const enabled = !disabledAgents.has(agent.name);
			entries.push({
				setting: {
					id: `agent:${agent.name}`,
					category: "agents",
					name: agent.name,
					description: agent.description,
					enabled,
					source: agent.source,
					restartRequired: false,
					...(enabled ? {} : { disabledReason: "item-disabled" }),
				},
				kind: "agent",
				name: agent.name,
			});
		}
		const seen = new Set<string>();
		for (const extension of extensions) {
			if (extension.state === "shadowed") continue;
			const category =
				extension.kind === "mcp"
					? "mcps"
					: extension.kind === "extension-module"
						? "extensions"
						: extension.kind === "skill"
							? "skills"
							: undefined;
			if (!category) continue;
			const id = `${extension.kind === "mcp" ? "mcp" : extension.kind === "extension-module" ? "extension" : "skill"}:${extension.name}`;
			if (seen.has(id)) continue;
			seen.add(id);
			const enabled = extension.disabledReason !== "item-disabled";
			entries.push({
				setting: {
					id,
					category,
					name: extension.name,
					...(category !== "mcps" && extension.description ? { description: extension.description } : {}),
					enabled,
					source: extension.source.provider,
					restartRequired: true,
					...(extension.disabledReason ? { disabledReason: extension.disabledReason } : {}),
				},
				kind: category === "mcps" ? "mcp" : "disabled-extension",
				name: extension.name,
				settingId: extension.id,
				sourcePath:
					category === "mcps" &&
					(extension.source.provider === "native" || extension.source.provider === "mcp-json")
						? extension.path
						: undefined,
			});
		}
		for (const plugin of npmPlugins)
			entries.push({
				setting: {
					id: `plugin:npm:${plugin.name}`,
					category: "plugins",
					name: plugin.name,
					description: plugin.manifest.description,
					enabled: plugin.enabled,
					source: "npm",
					restartRequired: true,
					...(plugin.enabled ? {} : { disabledReason: "item-disabled" }),
				},
				kind: "npm-plugin",
				name: plugin.name,
			});
		for (const plugin of marketplacePlugins) {
			if (plugin.shadowedBy) continue;
			const enabled = plugin.entries[0]?.enabled !== false;
			entries.push({
				setting: {
					id: `plugin:marketplace:${plugin.scope}:${plugin.id}`,
					category: "plugins",
					name: plugin.id,
					enabled,
					source: `marketplace:${plugin.scope}`,
					restartRequired: true,
					...(enabled ? {} : { disabledReason: "item-disabled" }),
				},
				kind: "marketplace-plugin",
				pluginId: plugin.id,
				scope: plugin.scope,
			});
		}
		return entries.sort((a, b) => a.setting.id.localeCompare(b.setting.id));
	}

	async #marketplace(cwd: string): Promise<MarketplaceManager> {
		return new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: clearPluginRootsAndCaches,
		});
	}

	#stringSettings(path: "disabledExtensions" | "task.disabledAgents"): string[] {
		const value = this.#session.settings.get(path);
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	}

	#disabledAgentsFor(cwd: string): Set<string> {
		if (this.#disabledAgents === undefined || this.#disabledAgentsCwd !== cwd) {
			this.#disabledAgents = new Set(this.#stringSettings("task.disabledAgents"));
			this.#disabledAgentsCwd = cwd;
		}
		return this.#disabledAgents;
	}

	async #updateDisabled(
		path: "disabledExtensions" | "task.disabledAgents",
		id: string,
		enabled: boolean,
	): Promise<void> {
		const values =
			path === "task.disabledAgents"
				? new Set(this.#disabledAgentsFor(this.#session.sessionManager.getCwd()))
				: new Set(this.#stringSettings(path));
		if (enabled) values.delete(id);
		else values.add(id);
		this.#session.settings.set(path, [...values].sort());
		await this.#session.settings.flush();
		if (path === "task.disabledAgents") {
			this.#disabledAgents = values;
			this.#disabledAgentsCwd = this.#session.sessionManager.getCwd();
		}
	}
}
