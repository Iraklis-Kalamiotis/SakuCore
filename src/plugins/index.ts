import type { EventHandler, EventRouter, GatewayDispatchHandler } from '../events/EventRouter.js';

export interface PluginMetadata {
  name: string;
  version?: string;
  dependencies?: string[];
}

export type PluginDisposer = () => void | Promise<void>;

export interface ScopedEventRouter<Events extends object> {
  on<Event extends keyof Events>(event: Event, handler: EventHandler<Events, Event>): this;
  once<Event extends keyof Events>(event: Event, handler: EventHandler<Events, Event>): this;
  off<Event extends keyof Events>(event: Event, handler: EventHandler<Events, Event>): this;
  emit<Event extends keyof Events>(event: Event, data: Events[Event]): void;
  onGateway(event: string, handler: GatewayDispatchHandler): this;
  offGateway(event: string, handler: GatewayDispatchHandler): this;
}

export interface PluginContext<Services extends object = Record<string, unknown>, Events extends object = Record<string, unknown>> {
  services: Services;
  events: ScopedEventRouter<Events>;
  signal: AbortSignal;
  cleanup(disposer: PluginDisposer): void;
}

export interface Plugin<Services extends object = Record<string, unknown>, Events extends object = Record<string, unknown>> {
  metadata: PluginMetadata;
  onLoad?(context: PluginContext<Services, Events>): void | Promise<void>;
  onEnable?(context: PluginContext<Services, Events>): void | Promise<void>;
  onDisable?(context: PluginContext<Services, Events>): void | Promise<void>;
  onUnload?(context: PluginContext<Services, Events>): void | Promise<void>;
}

interface PluginState<Services extends object, Events extends object> {
  controller: AbortController;
  context: PluginContext<Services, Events>;
  cleanups: PluginDisposer[];
  unlisten: PluginDisposer[];
}

export class PluginManager<Services extends object = Record<string, unknown>, Events extends object = Record<string, unknown>> {
  private readonly plugins = new Map<string, Plugin<Services, Events>>();
  private readonly loaded = new Set<string>();
  private readonly enabled = new Set<string>();
  private readonly states = new Map<string, PluginState<Services, Events>>();
  private loading = false;

  constructor(private readonly options: { services: Services; events: EventRouter<Events> }) {}

  register(...plugins: Plugin<Services, Events>[]): this {
    if (this.loading || this.loaded.size > 0) throw new Error('Plugins cannot be registered after loading begins');
    const candidates = new Map(this.plugins);
    for (const plugin of plugins) {
      const { name, dependencies = [] } = plugin.metadata;
      if (!name) throw new TypeError('Plugin metadata.name is required');
      if (candidates.has(name)) throw new Error(`Plugin "${name}" is already registered`);
      if (dependencies.some((dependency) => !dependency) || new Set(dependencies).size !== dependencies.length) {
        throw new TypeError(`Plugin "${name}" has invalid dependencies`);
      }
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
    const loadedNow: Plugin<Services, Events>[] = [];
    let current: Plugin<Services, Events> | undefined;
    try {
      for (const plugin of this.ordered()) {
        if (this.loaded.has(plugin.metadata.name)) continue;
        current = plugin;
        const state = this.createState();
        this.states.set(plugin.metadata.name, state);
        await plugin.onLoad?.(state.context);
        this.loaded.add(plugin.metadata.name);
        loadedNow.push(plugin);
        current = undefined;
      }
    } catch (error) {
      const rollbackErrors = current ? await this.disposeFailed(current) : [];
      rollbackErrors.push(...await this.unloadPlugins(loadedNow.reverse()));
      throw this.withRollback(error, rollbackErrors, 'Plugin load failed');
    }
  }

  async enable(): Promise<void> {
    await this.load();
    const enabledNow: Plugin<Services, Events>[] = [];
    let current: Plugin<Services, Events> | undefined;
    try {
      for (const plugin of this.ordered()) {
        if (this.enabled.has(plugin.metadata.name)) continue;
        current = plugin;
        let state = this.states.get(plugin.metadata.name);
        if (!state || state.controller.signal.aborted) {
          state = this.createState();
          this.states.set(plugin.metadata.name, state);
        }
        await plugin.onEnable?.(state.context);
        this.enabled.add(plugin.metadata.name);
        enabledNow.push(plugin);
        current = undefined;
      }
    } catch (error) {
      const rollbackErrors = current ? await this.disposeFailed(current) : [];
      rollbackErrors.push(...await this.disablePlugins(enabledNow.reverse()));
      throw this.withRollback(error, rollbackErrors, 'Plugin enable failed');
    }
  }

  async disable(): Promise<void> {
    const errors = await this.disablePlugins([...this.ordered()].reverse());
    if (errors.length > 0) throw new AggregateError(errors, 'Plugin disable failed');
  }

  async unload(): Promise<void> {
    const errors = await this.disablePlugins([...this.ordered()].reverse());
    errors.push(...await this.unloadPlugins([...this.ordered()].reverse()));
    if (errors.length > 0) throw new AggregateError(errors, 'Plugin unload failed');
  }

  private createState(): PluginState<Services, Events> {
    const controller = new AbortController();
    const cleanups: PluginDisposer[] = [];
    const unlisten: PluginDisposer[] = [];
    const events: ScopedEventRouter<Events> = {
      on: (event, handler) => {
        this.options.events.on(event, handler);
        unlisten.push(() => { this.options.events.off(event, handler); });
        return events;
      },
      once: (event, handler) => {
        this.options.events.once(event, handler);
        unlisten.push(() => { this.options.events.off(event, handler); });
        return events;
      },
      off: (event, handler) => {
        this.options.events.off(event, handler);
        return events;
      },
      emit: (event, data) => this.options.events.emit(event, data),
      onGateway: (event, handler) => {
        this.options.events.onGateway(event, handler);
        unlisten.push(() => { this.options.events.offGateway(event, handler); });
        return events;
      },
      offGateway: (event, handler) => {
        this.options.events.offGateway(event, handler);
        return events;
      },
    };
    return {
      controller,
      cleanups,
      unlisten,
      context: { services: this.options.services, events, signal: controller.signal, cleanup: (disposer) => cleanups.push(disposer) },
    };
  }

  private async disablePlugins(plugins: Plugin<Services, Events>[]): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const plugin of plugins) {
      const name = plugin.metadata.name;
      if (!this.enabled.has(name)) continue;
      const state = this.states.get(name);
      try {
        state?.controller.abort();
        await plugin.onDisable?.(state!.context);
      } catch (error) {
        errors.push(error);
      } finally {
        this.enabled.delete(name);
        if (state) errors.push(...await this.dispose(state));
      }
    }
    return errors;
  }

  private async unloadPlugins(plugins: Plugin<Services, Events>[]): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const plugin of plugins) {
      const name = plugin.metadata.name;
      if (!this.loaded.has(name)) continue;
      const state = this.states.get(name);
      try {
        state?.controller.abort();
        await plugin.onUnload?.(state!.context);
      } catch (error) {
        errors.push(error);
      } finally {
        this.loaded.delete(name);
        this.enabled.delete(name);
        if (state) {
          errors.push(...await this.dispose(state));
          this.states.delete(name);
        }
      }
    }
    return errors;
  }

  private async dispose(state: PluginState<Services, Events>): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const dispose of state.unlisten.splice(0).reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    for (const dispose of state.cleanups.splice(0).reverse()) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    return errors;
  }

  private async disposeFailed(plugin: Plugin<Services, Events>): Promise<unknown[]> {
    const state = this.states.get(plugin.metadata.name);
    if (!state) return [];
    state.controller.abort();
    const errors = await this.dispose(state);
    this.states.delete(plugin.metadata.name);
    return errors;
  }

  private withRollback(error: unknown, rollbackErrors: unknown[], message: string): unknown {
    return rollbackErrors.length === 0 ? error : new AggregateError([error, ...rollbackErrors], message);
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

export function definePlugin<Services extends object = Record<string, unknown>, Events extends object = Record<string, unknown>>(
  definition: Plugin<Services, Events>,
): Plugin<Services, Events> {
  return definition;
}

/** @deprecated Use definePlugin. */
export const plugin = definePlugin;
