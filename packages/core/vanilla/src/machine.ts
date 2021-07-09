import { toArray } from "@ui-machines/utils/array-utils"
import {
  isArray,
  isBoolean,
  isObject,
  isString,
} from "@ui-machines/utils/assertion-utils"
import { runIfFn, warn } from "@ui-machines/utils/function-utils"
import { globals } from "@ui-machines/utils/global-utils"
import { cast } from "@ui-machines/utils/type-utils"
import { ref, snapshot, subscribe } from "valtio/vanilla"
import { createProxyState } from "./create-proxy-state"
import { determineDelayFn } from "./delay-utils"
import { determineGuardFn } from "./guard-utils"
import { determineTransitionFn, toTransition } from "./transition-utils"
import {
  ActionTypes,
  Dict,
  MachineStatus,
  MachineType,
  StateMachine as S,
  VoidFunction,
} from "./types"
import { toEvent, uniqueId } from "./utils"

/**
 * Machine is used to create, interpret, and execute finite state machines.
 * It is inspired by XState, State Designer and Robot3.
 */
export class Machine<
  TContext extends Dict,
  TState extends S.StateSchema,
  TEvent extends S.EventObject = S.AnyEventObject,
> {
  public status: MachineStatus = MachineStatus.NotStarted
  public state: S.State<TContext, TState>
  public initialState: S.StateInfo<TContext, TState, TEvent> | undefined

  public id: string

  public type: MachineType = MachineType.Machine

  // Cleanup function map (per state)
  private activityEvents = new Map<string, Set<VoidFunction>>()
  private delayedEvents = new Map<string, VoidFunction[]>()

  // state update listeners the user can opt-in for
  private stateListeners = new Set<S.StateListener<TContext, TState>>()
  private contextListeners = new Set<S.ContextListener<TContext>>()
  private doneListeners = new Set<S.StateListener<TContext, TState>>()
  private removeStateListener: VoidFunction = () => void 0
  private removeContextListener: VoidFunction = () => void 0

  // For Parent <==> Spawned Actor relationship
  private parent?: AnyMachine
  private children = new Map<string, AnyMachine>()

  // A map of guard, action, delay implementations
  private guardMap?: S.GuardMap<TContext, TEvent>
  private actionMap?: S.ActionMap<TContext, TState, TEvent>
  private delayMap?: S.DelayMap<TContext, TEvent>
  private activityMap?: S.ActivityMap<TContext, TState, TEvent>

  // Let's get started!
  constructor(
    public config: S.MachineConfig<TContext, TState, TEvent>,
    public options?: S.MachineOptions<TContext, TState, TEvent>,
  ) {
    this.id = config.id ?? `machine-${uniqueId()}`
    this.state = createProxyState(config)

    if (options?.guards) {
      this.guardMap = options.guards
    }
    if (options?.actions) {
      this.actionMap = options.actions
    }
    if (options?.delays) {
      this.delayMap = options.delays
    }
    if (options?.activities) {
      this.activityMap = options.activities
    }
  }

  // immutable state value
  private get stateSnapshot(): S.State<TContext, TState> {
    return cast(snapshot(this.state))
  }

  // immutable context value
  private get contextSnapshot(): TContext {
    return this.stateSnapshot.context
  }

  // how state updates should be batched in valtio state
  // and context listeners
  private get sync() {
    const { syncListeners } = this.config

    const syncState = isBoolean(syncListeners)
      ? syncListeners
      : syncListeners?.state

    const syncContext = isBoolean(syncListeners)
      ? syncListeners
      : syncListeners?.context

    return { state: syncState, context: syncContext }
  }

  // Starts the interpreted machine.
  public start = (init?: S.StateInit<TContext, TState>) => {
    // Don't start if it's already running
    if (this.status === MachineStatus.Running) {
      return this
    }

    this.status = MachineStatus.Running
    const event = toEvent<TEvent>(ActionTypes.Init)

    if (init) {
      const resolved = isObject(init)
        ? init
        : { context: this.config.context!, value: init }

      this.setState(resolved.value)
      this.setContext(resolved.context)
    }

    // start transition definition
    const transition = {
      target: !!init ? undefined : this.config.initial,
    }

    const info = this.getNextStateInfo(transition, event)

    if (info) {
      info.target = cast(info.target || transition.target)
      this.initialState = info
      this.performStateChangeEffects(info.target, info, event)
    }

    this.removeStateListener = subscribe(
      this.state,
      () => {
        this.stateListeners.forEach((listener) => {
          listener(this.stateSnapshot)
        })
      },
      this.sync.state,
    )

    this.removeContextListener = subscribe(
      this.state.context,
      () => {
        this.contextListeners.forEach((listener) => {
          listener(this.contextSnapshot)
        })
      },
      this.sync.context,
    )

    this.executeActions(this.config.onStart, toEvent<TEvent>(ActionTypes.Start))
    return this
  }

  // Stops the interpreted machine
  stop = () => {
    // No need to call if already stopped
    if (this.status === MachineStatus.Stopped) return

    this.setState(null)
    this.state.event = ActionTypes.Stop

    if (this.config.context) {
      this.setContext(this.config.context)
    }

    // cleanups
    this.stopStateListeners()
    this.stopContextListeners()
    this.stopChildren()
    this.stopActivities()
    this.stopDelayedEvents()

    this.status = MachineStatus.Stopped
    this.executeActions(this.config.onStop, toEvent<TEvent>(ActionTypes.Stop))
    return this
  }

  private stopStateListeners = () => {
    this.removeStateListener()
    this.stateListeners.clear()
  }

  private stopContextListeners = () => {
    this.removeContextListener()
    this.contextListeners.clear()
  }

  private stopDelayedEvents = () => {
    this.delayedEvents.forEach((state) => {
      state.forEach((stop) => stop())
    })
    this.delayedEvents.clear()
  }

  // Cleanup running activities (e.g `setInterval`, invoked callbacks, promises)
  private stopActivities = (state?: TState["value"]) => {
    // stop activities for a state
    if (state) {
      this.activityEvents.get(state)?.forEach((stop) => stop())
      this.activityEvents.get(state)?.clear()
      this.activityEvents.delete(state)
    } else {
      // stop every running activity
      this.activityEvents.forEach((state) => {
        state.forEach((stop) => stop())
        state.clear()
      })
      this.activityEvents.clear()
    }
  }

  /**
   * Function to send event to spawned child machine or actor
   */
  sendChild = (
    evt: S.Event<S.AnyEventObject>,
    to: string | ((ctx: TContext) => string),
  ) => {
    const event = toEvent(evt)
    const id = runIfFn(to, this.contextSnapshot)
    const child = this.children.get(id)
    if (!child) {
      const msg = `[machine] Cannot send '${event.type}' event to unknown child`
      throw new Error(msg)
    }
    child.send(event)
  }

  /**
   * Function to stop a running child machine or actor
   */
  stopChild = (id: string) => {
    if (!this.children.has(id)) {
      const msg = "[machine] Cannot stop unknown child"
      throw new Error(msg)
    }
    this.children.get(id)!.stop()
    this.children.delete(id)
  }

  removeChild = (id: string) => {
    this.children.delete(id)
  }

  // Stop and delete spawned actors
  private stopChildren = () => {
    this.children.forEach((child) => child.stop())
    this.children.clear()
  }

  setParent = (parent: any) => {
    this.parent = parent
  }

  public spawn = (src: MachineSrc<any, any, any>, id?: string) => {
    const actor = typeof src === "function" ? src() : src
    if (id) actor.id = id
    actor.type = MachineType.Actor

    actor.setParent(this)
    this.children.set(actor.id, actor)

    actor
      .onDone(() => {
        this.removeChild(actor.id)
      })
      .start()

    return ref<any>(actor)
  }

  private addActivityCleanup = (
    state: TState["value"] | null,
    cleanup: VoidFunction,
  ) => {
    if (!state) return
    if (!this.activityEvents.has(state)) {
      this.activityEvents.set(state, new Set([cleanup]))
    } else {
      this.activityEvents.get(state)?.add(cleanup)
    }
  }

  private setState = (target: TState["value"] | null) => {
    this.state.previousValue = this.state.value
    this.state.value = target

    const stateNode = this.getStateNode(target)

    if (target == null) {
      this.state.tags.clear()
    } else {
      this.state.tags = new Set(toArray(stateNode?.tags))
    }
  }

  /**
   * To used within side effects for React or Vue to update context
   */
  setContext = (context: Partial<TContext>) => {
    for (const key in context) {
      this.state.context[key] = context[key]!
    }
  }

  withContext = (context: Partial<TContext>) => {
    const newContext = { ...this.config.context, ...context } as TContext
    return new Machine({ ...this.config, context: newContext }, this.options)
  }

  withConfig = (config: Partial<S.MachineConfig<TContext, TState, TEvent>>) => {
    return new Machine({ ...this.config, ...config }, this.options)
  }

  withOptions = (
    options: Partial<S.MachineOptions<TContext, TState, TEvent>>,
  ) => {
    return new Machine(this.config, { ...this.options, ...options })
  }

  updateActions = (
    actions: Partial<S.MachineOptions<TContext, TState, TEvent>>["actions"],
  ) => {
    this.actionMap = { ...this.actionMap, ...actions }
  }

  private getStateNode = (state: TState["value"] | null) => {
    if (!state) return
    return this.config.states?.[state]
  }

  private getNextStateInfo = (
    transitions: S.Transitions<TContext, TState["value"], TEvent>,
    event: TEvent,
  ): S.StateInfo<TContext, TState, TEvent> => {
    const resolvedTransition = this.determineTransition(transitions, event)
    const target = resolvedTransition?.target ?? this.state.value
    const stateNode = this.getStateNode(target)

    return {
      transition: resolvedTransition,
      stateNode,
      target: target!,
    }
  }

  private getActionFromDelayedTransition = (
    transition: S.DelayedTransition<TContext, TState["value"], TEvent>,
  ) => {
    // get the computed delay
    const event = toEvent<TEvent>(ActionTypes.After)

    const determineDelay = determineDelayFn(transition.delay, this.delayMap)
    const delay = determineDelay(this.contextSnapshot, event) ?? 0

    let id: ReturnType<typeof globals.setTimeout>

    return {
      entry: () => {
        id = globals.setTimeout(() => {
          const current = this.state.value!
          const next = this.getNextStateInfo(transition, event)
          this.performStateChangeEffects(current, next, event)
        }, delay)
      },
      exit: () => {
        globals.clearTimeout(id)
      },
    }
  }

  /**
   * All `after` events leverage `setTimeout` and `clearTimeout`,
   * we invoke the `clearTimeout` on exit and `setTimeout` on entry.
   *
   * To achieve this, we split the `after` defintion into `entry` and `exit`
   *  functions and append them to the state's `entry` and `exit` actions
   */
  private getDelayedEventActions = (state: TState["value"]) => {
    const stateNode = this.getStateNode(state)
    const event = toEvent<TEvent>(ActionTypes.After)

    if (!stateNode || !stateNode.after) return

    const entries: VoidFunction[] = []
    const exits: VoidFunction[] = []

    if (isArray(stateNode.after)) {
      //
      const transition = this.determineTransition(stateNode.after, event)
      if (!transition) return

      const actions = this.getActionFromDelayedTransition(transition)
      entries.push(actions.entry)
      exits.push(actions.exit)
      //
    } else if (isObject(stateNode.after)) {
      //
      for (const delay in stateNode.after) {
        const transition = stateNode.after[delay]
        let resolvedTransition: S.DelayedTransition<
          TContext,
          TState["value"],
          TEvent
        > = {}

        if (isArray(transition)) {
          //
          const picked = this.determineTransition(transition, event)
          if (picked) resolvedTransition = picked
          //
        } else if (isString(transition)) {
          resolvedTransition = { target: transition, delay }
        } else {
          resolvedTransition = { ...transition, delay }
        }

        const actions = this.getActionFromDelayedTransition(resolvedTransition)

        entries.push(actions.entry)
        exits.push(actions.exit)
      }
    }

    return { entries, exits }
  }

  /**
   * Function to executes defined actions. It can accept actions as string
   * (referencing `options.actions`) or actual functions.
   */
  private executeActions = (
    actions: S.Actions<TContext, TEvent> | undefined,
    event: TEvent,
  ) => {
    for (const action of toArray(actions)) {
      const fn = isString(action) ? this.actionMap?.[action] : action

      warn(
        isString(action) && !fn,
        `[machine] No implementation found for action type ${action}`,
      )

      const meta = {
        state: this.stateSnapshot,
        guards: this.guardMap,
      }

      fn?.(this.state.context, event, meta)
    }
  }

  /**
   * Function to execute running activities and registers
   * their cleanup function internally (to be called later on when we exit the state)
   */
  private executeActivities = (
    event: TEvent,
    activities: Array<S.Activity<TContext, TState, TEvent>>,
  ) => {
    for (const activity of activities) {
      const fn = isString(activity) ? this.activityMap?.[activity] : activity

      if (!fn) {
        warn(
          isString(activity),
          `[machine] No implementation found for activity type ${activity}`,
        )
        continue
      }

      const meta = {
        state: this.stateSnapshot,
        guards: this.guardMap,
        send: this.send.bind(this),
      }

      const cleanup = fn(this.state.context, event, meta)
      this.addActivityCleanup(this.state.value, cleanup)
    }
  }

  /**
   * Normalizes the `every` definition to transition. `every` can be:
   * - An array of possible actions to run (we need to pick the first match based on cond)
   * - An object of intervals and actions
   */
  private createEveryActivities = (
    every: S.StateNode<TContext, TState, TEvent>["every"] | undefined,
    callbackfn: (activity: S.Activity<TContext, TState, TEvent>) => void,
  ) => {
    if (!every) return
    const event = toEvent<TEvent>(ActionTypes.Every)

    // every: [{ interval: 2000, actions: [...], cond: "isValid" },  { interval: 1000, actions: [...] }]
    if (isArray(every)) {
      // picked = { interval: string | number | <ref>, actions: [...], cond: ... }
      const picked = toArray(every).find((t) => {
        //
        const determineDelay = determineDelayFn(t.interval, this.delayMap)
        t.interval = determineDelay(this.contextSnapshot, event)

        const determineGuard = determineGuardFn(t.cond, this.guardMap)
        const cond = determineGuard(this.contextSnapshot, event)

        return cond ?? t.interval
      })

      if (!picked) return

      const determineDelay = determineDelayFn(picked.interval, this.delayMap)
      const delay = determineDelay(this.contextSnapshot, event)

      const activity = () => {
        const id = global.setInterval(() => {
          this.executeActions(picked.actions, event)
        }, delay)
        return () => {
          globals.clearInterval(id)
        }
      }
      callbackfn(activity)
      //
    } else {
      // every = { 1000: [fn, fn] }
      for (const interval in every) {
        const actions = every?.[interval]

        // interval could be a `ref` not the actual interval value, let's determine the actual value
        const determineDelay = determineDelayFn(interval, this.delayMap)
        const delay = determineDelay(this.contextSnapshot, event)

        // create the activity to run for each `every` reaction
        const activity = () => {
          const id = globals.setInterval(() => {
            this.executeActions(actions, event)
          }, delay)
          return () => {
            globals.clearInterval(id)
          }
        }
        callbackfn(activity)
      }
    }
  }

  private setEvent = (event: TEvent) => {
    const eventType = toEvent(event).type
    this.state.event =
      eventType === ActionTypes.Sync
        ? [this.state.event, ActionTypes.Sync].join(" > ")
        : eventType
  }

  private performExitEffects = (
    current: TState["value"] | undefined,
    event: TEvent,
  ) => {
    const currentState = this.state.value!
    const stateNode = current ? this.getStateNode(current) : undefined

    // get explicit exit and implicit "after.exit" actions for current state
    const exitActions = toArray(stateNode?.exit)

    const afterExitActions = this.delayedEvents.get(currentState)
    if (afterExitActions) {
      exitActions.push(...afterExitActions)
    }

    // call all exit actions for current state
    this.executeActions(exitActions, event)

    // cleanup activities for current state
    this.stopActivities(currentState)
  }

  private performEntryEffects = (next: TState["value"], event: TEvent) => {
    const stateNode = this.getStateNode(next)

    // get all entry actions
    const entryActions = toArray(stateNode?.entry)
    const afterActions = this.getDelayedEventActions(next)

    if (stateNode?.after && afterActions) {
      this.delayedEvents.set(next, afterActions?.exits)
      entryActions.push(...afterActions.entries)
    }

    // execute entry actions for next state
    this.executeActions(entryActions, event)

    // execute activities for next state
    const activities = toArray(stateNode?.activities)

    // if `every` is defined, create an activity and append to activities
    this.createEveryActivities(stateNode?.every, (activity) => {
      activities.unshift(activity)
    })

    if (activities.length > 0) {
      this.executeActivities(event, activities)
    }

    if (stateNode?.type === "final") {
      this.state.done = true
      this.doneListeners.forEach((listener) => {
        listener(this.stateSnapshot)
      })
      this.stop()
    }
  }

  private performTransitionEffects = (
    transition: S.Transitions<TContext, TState["value"], TEvent> | undefined,
    event: TEvent,
  ) => {
    // execute transition actions
    const t = this.determineTransition(transition, event)
    this.executeActions(t?.actions, event)
  }

  /**
   * @see https://statecharts.dev/glossary/self-transition.html
   */
  private performSelfTransition = (
    transition: S.Transitions<TContext, TState["value"], TEvent> | undefined,
    event: TEvent,
  ) => {
    const target = this.state.value!

    this.performExitEffects(target, event)
    this.performTransitionEffects(transition, event)
    this.setState(target)
    this.performEntryEffects(target, event)
  }

  /**
   * Performs all the requires side-effects or reactions when
   * we move from state A => state B.
   *
   * The Effect order:
   * Exit actions (current state) => Transition actions  => Go to state => Entry actions (next state)
   */
  private performStateChangeEffects = (
    current: TState["value"] | undefined,
    next: S.StateInfo<TContext, TState, TEvent>,
    event: TEvent,
  ) => {
    // update event
    this.setEvent(event)

    // determine next target
    next.target = next.target ?? this.state.value ?? undefined
    const ok = next.target && next.target !== this.state.value

    if (ok) {
      this.performExitEffects(current, event)
    }

    // execute transition actions
    this.performTransitionEffects(next?.transition, event)

    // go to next state
    this.setState(next.target)

    if (ok) {
      this.performEntryEffects(next.target, event)
    }
  }

  private determineTransition = (
    transition: S.Transitions<TContext, TState["value"], TEvent> | undefined,
    event: TEvent,
  ) => {
    const fn = determineTransitionFn(transition, this.guardMap)
    return fn?.(this.contextSnapshot, event)
  }

  /**
   * Function to send event to parent machine from spawned child
   */
  sendParent = (evt: S.EventWithSrc) => {
    if (!this.parent) {
      const msg = "[machine]: Cannot send event to an unknown parent"
      throw new Error(msg)
    }
    const event = toEvent<S.EventWithSrc>(evt)
    this.parent?.send(event)
  }

  /**
   * Function to send an event to current machine
   */
  send = (evt: S.Event<TEvent>): void | Promise<void> => {
    const event = toEvent<TEvent>(evt)
    this.transition(this.state.value, event)
  }

  transition = (
    state: TState["value"] | S.StateInfo<TContext, TState, TEvent> | null,
    evt: S.Event<TEvent>,
  ) => {
    const stateNode = isString(state)
      ? this.getStateNode(state)
      : state?.stateNode

    const event = toEvent(evt)

    if (!stateNode && !this.config.on) {
      const msg =
        this.status === MachineStatus.Stopped
          ? "[machine] Cannot transition a stopped machine"
          : "[machine] State does not have a definition"
      warn(true, msg)
      return
    }

    const transitionConfig: S.Transitions<TContext, TState["value"], TEvent> =
      this.config.on?.[event.type] ?? stateNode?.on?.[event.type]

    const transition = toTransition(transitionConfig, this.state.value)

    if (!transition) return

    const info = this.getNextStateInfo(transition, event)

    if (info) {
      this.performStateChangeEffects(info.target, info, event)
    }

    return info.stateNode
  }

  subscribe = (listener: S.StateListener<TContext, TState>) => {
    this.stateListeners.add(listener)

    if (this.status === MachineStatus.Running) {
      listener(this.stateSnapshot)
    }

    return () => {
      this.stateListeners.delete(listener)
    }
  }

  public onDone = (listener: S.StateListener<TContext, TState>) => {
    this.doneListeners.add(listener)
    return this
  }

  public onTransition = (listener: S.StateListener<TContext, TState>) => {
    this.stateListeners.add(listener)
    if (this.status === MachineStatus.Running) {
      listener(this.stateSnapshot)
    }
    return this
  }

  public onChange = (listener: S.ContextListener<TContext>) => {
    this.contextListeners.add(listener)
    return this
  }
}

export type MachineSrc<
  TContext extends Dict,
  TState extends S.StateSchema,
  TEvent extends S.EventObject = S.AnyEventObject,
> =
  | Machine<TContext, TState, TEvent>
  | (() => Machine<TContext, TState, TEvent>)

export type AnyMachine = Machine<any, any, any>
