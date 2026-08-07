import type { EventRouter } from '../events/EventRouter.js';

export interface PluginMetadata {
  name: string;
  version?: string;
  dependencies?: string[];
}

export interface PluginContext<Services extends object = Record<string, unknown>, Events extends object = Record<string, unknown>> {
  services: Services;
  events: EventRouter<Events>;
}

export interface Plugin<Services extends object = Record<string, unknown>, Events extends object = Record<string, unknown>> {
  metadata: PluginMetadata;
  onLoad?(context: PluginContext<Services, Events>): void | Promise<void>;
  onEnable?(context: PluginContext<Services, Events>): void | Promise<void>;
  onDisable?(context: PluginContext<Services, Events>): void | Promise<void>;
}

export class PluginManager<Services extends object = Record<string, unknown>, Events extends object = Record<string, unknown>> {
  private readonly plugins = new Map<string, Plugin<Services, Events>>();
  private readonly loaded = new Set<string>();
  private readonly enabled = new Set<string>();
  private loading = false;

  constructor(private readonly context: PluginContext<Services, Events>) {}

  register(...plugins: Plugin<Services, Events>[]): this {
    if (this.loading || this.loaded.size > 0) throw new Error('Plugins cannot be registered after loading begins');
    const candidates = new Map(this.plugins);
    for (const plugin of plugins) {
      const { name, dependencies = [] } = plugin.metadata;
      if (!name) throw new TypeError('Plugin metadata.name is required');
      if (candidates.has(name)) throw new Error(`Plugin "${name}" is already registered`);
      if (dependencies.some((dependency) => !dependency)) throw new TypeError(`Plugin "${name}" has an invalid dependency`);
      candidates.set(name, plugin);
    }
    for (const [name, plugin] of candidates) {
      for (const dependency of plugin.metadata.dependencies ?? []) {
        if (!candidates.has(dependency)) throw new Error(`Plugin "${name}" requires missing dependency "${dependency}"`);
      }
    }
    this.assertAcyclic(candidates);
    for (const plugin of plugins) this.plugins.set(plugin.metadata.name, plugin);
    return this;
  }

  async load(): Promise<void> {
    this.loading = true;
    for (const plugin of this.ordered()) {
      if (this.loaded.has(plugin.metadata.name)) continue;
      await plugin.onLoad?.(this.context);
      this.loaded.add(plugin.metadata.name);
    }
  }

  async enable(): Promise<void> {
    await this.load();
    for (const plugin of this.ordered()) {
      if (this.enabled.has(plugin.metadata.name)) continue;
      await plugin.onEnable?.(this.context);
      this.enabled.add(plugin.metadata.name);
    }
  }

  async disable(): Promise<void> {
    for (const plugin of [...this.ordered()].reverse()) {
      if (!this.enabled.has(plugin.metadata.name)) continue;
      await plugin.onDisable?.(this.context);
      this.enabled.delete(plugin.metadata.name);
    }
  }

  private ordered(): Plugin<Services, Events>[] {
    const ordered: Plugin<Services, Events>[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) throw new Error(`Plugin dependency cycle detected at "${name}"`);
      visiting.add(name);
      const plugin = this.plugins.get(name)!;
      for (const dependency of plugin.metadata.dependencies ?? []) visit(dependency);
      visiting.delete(name);
      visited.add(name);
      ordered.push(plugin);
    };
    for (const name of this.plugins.keys()) visit(name);
    return ordered;
  }

  private assertAcyclic(plugins: ReadonlyMap<string, Plugin<Services, Events>>): void {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string): void => {
      if (visited.has(name)) return;
      if (visiting.has(name)) throw new Error(`Plugin dependency cycle detected at "${name}"`);
      visiting.add(name);
      for (const dependency of plugins.get(name)!.metadata.dependencies ?? []) visit(dependency);
      visiting.delete(name);
      visited.add(name);
    };
    for (const name of plugins.keys()) visit(name);
  }
}

export function plugin<Services extends object = Record<string, unknown>, Events extends object = Record<string, unknown>>(
  definition: Plugin<Services, Events>,
): Plugin<Services, Events> {
  return definition;
}
