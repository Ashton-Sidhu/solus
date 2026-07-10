import { base64UrlToUint8Array } from "@client-core/push";
import type { WebPushSubscriptionJSON } from "@shared/types";

class WebPushState {
  supported = $state(false);
  permission = $state<NotificationPermission>("default");
  subscribed = $state(false);
  busy = $state(false);

  private registration: ServiceWorkerRegistration | null = null;
  private publicKey: string | null = null;

  init(): void {
    this.supported = isPushSupported();
    if (!this.supported) return;
    this.permission = Notification.permission;
    void this.refresh();
  }

  async ensureSubscribedSilently(): Promise<void> {
    if (!this.supported || Notification.permission !== "granted") return;
    await this.subscribe();
  }

  async subscribeWithPermission(): Promise<void> {
    if (!this.supported || this.busy) return;
    this.busy = true;
    try {
      if (Notification.permission === "default") {
        this.permission = await Notification.requestPermission();
      } else {
        this.permission = Notification.permission;
      }
      if (this.permission === "granted") await this.subscribe();
    } finally {
      this.busy = false;
    }
  }

  async unsubscribe(): Promise<void> {
    if (!this.supported || this.busy) return;
    this.busy = true;
    try {
      const registration = await this.ensureRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
      await window.solus.pushUnsubscribe();
      this.subscribed = false;
      this.permission = Notification.permission;
    } finally {
      this.busy = false;
    }
  }

  async toggle(): Promise<void> {
    if (this.subscribed) await this.unsubscribe();
    else await this.subscribeWithPermission();
  }

  private async refresh(): Promise<void> {
    if (!this.supported) return;
    try {
      const registration = await this.ensureRegistration();
      this.subscribed = !!(await registration.pushManager.getSubscription());
      this.permission = Notification.permission;
    } catch {
      this.supported = false;
    }
  }

  private async subscribe(): Promise<void> {
    const registration = await this.ensureRegistration();
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(await this.getPublicKey()),
    });
    const json = subscription.toJSON() as WebPushSubscriptionJSON;
    if (!json.endpoint || !json.keys?.auth || !json.keys?.p256dh) {
      throw new Error("Push subscription is missing browser keys");
    }
    await window.solus.pushSubscribe(json);
    this.subscribed = true;
    this.permission = Notification.permission;
  }

  private async getPublicKey(): Promise<string> {
    if (!this.publicKey) this.publicKey = await window.solus.pushGetPublicKey();
    return this.publicKey;
  }

  private async ensureRegistration(): Promise<ServiceWorkerRegistration> {
    if (!this.registration) {
      this.registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    }
    return this.registration;
  }
}

function isPushSupported(): boolean {
  return typeof window !== "undefined" &&
    window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window;
}

export const webPushState = new WebPushState();
