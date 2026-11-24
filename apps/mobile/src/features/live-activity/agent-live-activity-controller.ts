import {
  AGENT_ACTIVITY_IDLE_AFTER_MS,
  AGENT_ACTIVITY_STALE_AFTER_MS,
  type AgentActivityCard,
} from "@solus/contracts/uplink";
import type { KeyValueStore } from "@solus-mobile/platform/ports";
import {
  deriveAgentActivity,
  type AgentActivityInput,
} from "./agent-activity-model";

/**
 * Keeps one Live Activity (Lock Screen, Always-On Display and Dynamic Island)
 * in step with the sessions this device knows, as T3 Code keeps its one
 * aggregate card per device.
 *
 * While the app runs, every change lands within a moment. Once iOS suspends
 * it, the hosts update the card: each card the app shows goes to the relay
 * with the card's push token, and each host reports its own rows to the
 * control plane, which sends the card through APNs
 * (docs/plans/live-activity-push.md). A host that cannot reach the control
 * plane does not update it; the card's stale date (10 minutes, T3's window)
 * then offers "Tap to refresh" instead of claiming work it cannot see.
 * A card starts only while the app is in front, as ActivityKit allows and as
 * T3 does; it ends after five minutes without live work.
 */

export interface LiveActivityHandle {
  /** The ActivityKit id: each read of the cards answers new handles for the same card. */
  getId(): string;
  update(props: AgentActivityCard, staleDate: Date): Promise<void>;
  end(
    policy: "default" | "immediate",
    props?: AgentActivityCard,
  ): Promise<void>;
  /** The card's APNs push token: iOS issues it after the card starts and may replace it. */
  onPushToken(listener: (pushToken: string) => void): () => void;
}

export interface LiveActivityBridge {
  /** Cards that already exist: from an earlier run of the app, too. */
  instances(): LiveActivityHandle[];
  /** Null where Live Activities are not available or are turned off in iOS Settings. */
  start(props: AgentActivityCard, staleDate: Date): LiveActivityHandle | null;
}

/** The hosts that update the card while the app is suspended. */
export interface LiveActivityRelay {
  /** The card as it shows now; `generation` orders the cards one push token carried. */
  register(
    pushToken: string,
    generation: number,
    card: AgentActivityCard,
  ): void;
  /** The card ended, or this token no longer belongs to it. */
  unregister(pushToken: string): void;
}

export interface AgentLiveActivityDeps {
  readonly bridge: LiveActivityBridge;
  /** Every known host has answered its first session read. */
  readonly ready: () => boolean;
  readonly read: () => Pick<
    AgentActivityInput,
    "threads" | "liveStatus" | "awaitingApprovals" | "projectTitleOf"
  >;
  readonly enabled: () => boolean;
  readonly foreground: () => boolean;
  readonly now: () => number;
  /** Keeps the card's sessions across a restart, so a card left running can show how its work ended. */
  readonly storage: Pick<KeyValueStore, "getItem" | "setItem" | "removeItem">;
  readonly relay: LiveActivityRelay;
  readonly scope: string;
  /** A cancellable idle deadline. Tests can advance it without wall time. */
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
  readonly onError?: (error: unknown) => void;
}

const SCOPE_KEY = "solus.liveActivities.scope";
const TRACKED_KEY = "solus.liveActivities.tracked";
const IDLE_SINCE_KEY = "solus.liveActivities.idleSince";

function scheduleIdle(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
}

export class AgentLiveActivityController {
  private activity: LiveActivityHandle | null = null;
  private adopted = false;
  private tracked: ReadonlyMap<string, number | null> = new Map();
  /** The last content sent, without its timestamps, so a repeat is not sent again. */
  private sent = "";
  /** The card as last sent, for the relay when the push token arrives later. */
  private card: AgentActivityCard | null = null;
  private pushToken: string | null = null;
  private stopPushToken: (() => void) | null = null;
  private generation = 0;
  private idleSince: number | null = null;
  private cancelIdle: (() => void) | null = null;

  constructor(private readonly deps: AgentLiveActivityDeps) {}

  /** Read the sessions again and start, update or end the card to match. */
  sync(): void {
    if (!this.deps.enabled()) {
      this.endAll("immediate");
      return;
    }
    // Before the hosts answer, an empty list would end a card that is still true.
    if (!this.deps.ready()) return;
    this.adopt();
    // A card the person swiped away takes no updates: the next one starts fresh.
    if (this.activity && !this.isActive(this.activity))
      this.drop(this.activity);
    const state = deriveAgentActivity({
      ...this.deps.read(),
      tracked: this.tracked,
      now: this.deps.now(),
    });
    this.track(state.tracked);
    if (!state.props) {
      // Nothing this run knows of: a card left from an earlier run cannot be vouched for.
      this.endAll("immediate");
      return;
    }
    if (state.activeCount === 0) {
      if (!this.activity) return;
      if (this.idleSince === null) {
        this.idleSince = this.deps.now();
        this.deps.storage.setItem(IDLE_SINCE_KEY, String(this.idleSince));
      }
      const remaining =
        this.idleSince + AGENT_ACTIVITY_IDLE_AFTER_MS - this.deps.now();
      if (remaining <= 0) {
        this.endAll("immediate");
        return;
      }
      if (!this.cancelIdle)
        this.cancelIdle = (this.deps.schedule ?? scheduleIdle)(() => {
          this.cancelIdle = null;
          this.sync();
        }, remaining);
    } else {
      this.clearIdle();
    }
    const staleDate = new Date(this.deps.now() + AGENT_ACTIVITY_STALE_AFTER_MS);
    const content = JSON.stringify({
      ...state.props,
      updatedAt: "",
      activities: state.props.activities.map((row) => ({
        ...row,
        updatedAt: "",
      })),
    });
    if (!this.activity) {
      if (!this.deps.foreground()) return;
      try {
        this.setActivity(this.deps.bridge.start(state.props, staleDate));
        this.sent = content;
        this.sendToRelay(state.props);
      } catch (error) {
        this.deps.onError?.(error);
      }
      return;
    }
    if (content === this.sent) return;
    this.sent = content;
    this.sendToRelay(state.props);
    const card = this.activity;
    card.update(state.props, staleDate).catch((error: unknown) => {
      if (this.activity !== card || this.sent !== content) return;
      // A rejected update does not prove that iOS removed the card.
      if (!this.isActive(card)) this.drop(card);
      else this.sent = "";
      this.deps.onError?.(error);
    });
  }

  /** Renew the stale date while the app runs, even when the session status has not changed. */
  refresh(): void {
    this.sent = "";
    this.sync();
  }

  clear(): void {
    this.endAll("immediate");
  }

  /** Stop local deadlines when the hook unmounts; the relay still owns background updates. */
  dispose(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.stopPushToken?.();
    this.stopPushToken = null;
  }

  private clearIdle(): void {
    this.cancelIdle?.();
    this.cancelIdle = null;
    this.idleSince = null;
    if (this.deps.storage.getItem(IDLE_SINCE_KEY) !== null)
      this.deps.storage.removeItem(IDLE_SINCE_KEY);
  }

  private adopt(): void {
    if (this.adopted) return;
    this.adopted = true;
    let existing: LiveActivityHandle[] = [];
    try {
      existing = this.deps.bridge.instances();
    } catch (error) {
      this.deps.onError?.(error);
    }
    if (this.deps.storage.getItem(SCOPE_KEY) !== this.deps.scope) {
      this.deps.storage.setItem(SCOPE_KEY, this.deps.scope);
      this.deps.storage.removeItem(TRACKED_KEY);
      this.clearIdle();
      for (const card of existing) this.guard(card.end("immediate"));
      return;
    }
    const [first, ...extra] = existing;
    // One card per device; extras from a race end now.
    for (const card of extra) this.guard(card.end("immediate"));
    this.setActivity(first ?? null);
    // The sessions the earlier run's card showed: the ones that finished
    // since then stay on it as Done or Failed.
    if (first)
      this.tracked = new Map(this.savedKeys().map((key) => [key, null]));
    else this.deps.storage.removeItem(TRACKED_KEY);
    const savedIdle = this.deps.storage.getItem(IDLE_SINCE_KEY);
    const idleSince = savedIdle === null ? NaN : Number(savedIdle);
    if (first && Number.isFinite(idleSince)) this.idleSince = idleSince;
    else this.clearIdle();
  }

  private endAll(policy: "default" | "immediate"): void {
    this.adopt();
    this.clearIdle();
    const card = this.activity;
    this.setActivity(null);
    this.track(new Map());
    this.sent = "";
    if (card) this.guard(card.end(policy));
  }

  /** False once the card is gone: the person swiped it away, or iOS ended it. */
  private isActive(card: LiveActivityHandle): boolean {
    try {
      const id = card.getId();
      return this.deps.bridge
        .instances()
        .some((instance) => instance.getId() === id);
    } catch (error) {
      this.deps.onError?.(error);
      return true;
    }
  }

  private drop(card: LiveActivityHandle): void {
    if (this.activity !== card) return;
    this.setActivity(null);
    this.clearIdle();
    this.sent = "";
  }

  /** The one place the card changes: its push token follows it. */
  private setActivity(next: LiveActivityHandle | null): void {
    if (next === this.activity) return;
    this.stopPushToken?.();
    this.stopPushToken = null;
    this.forgetPushToken();
    this.card = null;
    this.activity = next;
    if (!next) return;
    this.stopPushToken = next.onPushToken((pushToken) => {
      if (this.activity !== next || pushToken === this.pushToken) return;
      this.forgetPushToken();
      this.pushToken = pushToken;
      if (this.card) this.register(pushToken, this.card);
    });
  }

  private sendToRelay(card: AgentActivityCard): void {
    this.card = card;
    if (this.pushToken) this.register(this.pushToken, card);
  }

  private register(pushToken: string, card: AgentActivityCard): void {
    // Strictly increasing: the relay keeps the highest generation it was told.
    this.generation = Math.max(this.deps.now(), this.generation + 1);
    this.deps.relay.register(pushToken, this.generation, card);
  }

  private forgetPushToken(): void {
    if (this.pushToken) this.deps.relay.unregister(this.pushToken);
    this.pushToken = null;
  }

  private track(next: ReadonlyMap<string, number | null>): void {
    const changed =
      next.size !== this.tracked.size ||
      [...next.keys()].some((key) => !this.tracked.has(key));
    this.tracked = next;
    if (!changed) return;
    if (next.size === 0) this.deps.storage.removeItem(TRACKED_KEY);
    else
      this.deps.storage.setItem(TRACKED_KEY, JSON.stringify([...next.keys()]));
  }

  private savedKeys(): string[] {
    try {
      const saved: unknown = JSON.parse(
        this.deps.storage.getItem(TRACKED_KEY) ?? "[]",
      );
      return Array.isArray(saved)
        ? saved.filter((key): key is string => typeof key === "string")
        : [];
    } catch {
      return [];
    }
  }

  private guard(work: Promise<void>): void {
    work.catch((error: unknown) => this.deps.onError?.(error));
  }
}
