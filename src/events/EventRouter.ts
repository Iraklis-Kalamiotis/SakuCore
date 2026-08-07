import type { ErrorManager } from '../core/ErrorManager.js';

export type EventHandler<Events extends object, Event extends keyof Events> =
  (data: Events[Event]) => void | Promise<unknown>;
export type GatewayDispatchHandler = (data: unknown) => void | Promise<unknown>;

/**
 * Routes named gateway dispatches through an O(1) lookup and safely observes
 * synchronous errors and asynchronous handler rejections.
 */
export class EventRouter<Events extends object> {
  private readonly eventHandlers = new Map<keyof Events, Set<EventHandler<Events, keyof Events>>>();
  private readonly gatewayHandlers = new Map<string, Set<GatewayDispatchHandler>>();

  constructor(
    private readonly errors: ErrorManager,
    private readonly errorEvent?: keyof Events,
  ) {}

  on<Event extends keyof Events>(event: Event, handler: EventHandler<Events, Event>): this {
    const handlers = this.eventHandlers.get(event) ?? new Set<EventHandler<Events, keyof Events>>();
    handlers.add(handler as EventHandler<Events, keyof Events>);
    this.eventHandlers.set(event, handlers);
    return this;
  }

  once<Event extends keyof Events>(event: Event, handler: EventHandler<Events, Event>): this {
    const wrapper: EventHandler<Events, Event> = (data) => {
      this.off(event, wrapper);
      return handler(data);
    };
    return this.on(event, wrapper);
  }

  off<Event extends keyof Events>(event: Event, handler: EventHandler<Events, Event>): this {
    this.eventHandlers.get(event)?.delete(handler as EventHandler<Events, keyof Events>);
    return this;
  }

  emit<Event extends keyof Events>(event: Event, data: Events[Event]): void {
    for (const handler of this.eventHandlers.get(event) ?? []) {
      this.invoke(handler as EventHandler<Events, Event>, data, event !== this.errorEvent);
    }
  }

  onGateway(event: string, handler: GatewayDispatchHandler): this {
    const handlers = this.gatewayHandlers.get(event) ?? new Set<GatewayDispatchHandler>();
    handlers.add(handler);
    this.gatewayHandlers.set(event, handlers);
    return this;
  }

  offGateway(event: string, handler: GatewayDispatchHandler): this {
    this.gatewayHandlers.get(event)?.delete(handler);
    return this;
  }

  dispatch(event: string | null, data: unknown): void {
    if (!event) return;
    for (const handler of this.gatewayHandlers.get(event) ?? []) {
      this.invoke(handler, data, true);
    }
  }

  clear(): void {
    this.eventHandlers.clear();
    this.gatewayHandlers.clear();
  }

  private invoke<Event extends keyof Events>(
    handler: EventHandler<Events, Event>,
    data: Events[Event],
    emitErrorEvent: boolean,
  ): void;
  private invoke(handler: GatewayDispatchHandler, data: unknown, emitErrorEvent: boolean): void;
  private invoke(
    handler: ((data: never) => void | Promise<void>) | GatewayDispatchHandler,
    data: unknown,
    emitErrorEvent: boolean,
  ): void {
    try {
      void Promise.resolve((handler as GatewayDispatchHandler)(data))
        .catch((error: unknown) => this.errors.report(error, emitErrorEvent));
    } catch (error) {
      this.errors.report(error, emitErrorEvent);
    }
  }
}
