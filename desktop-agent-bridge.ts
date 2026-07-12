/**
 * Desktop Agent Bridge — connects Node.js server to the Python Desktop AI sidecar.
 * 
 * The Python sidecar (desktop_agent/desktop_manager.py) runs on port 3001.
 * This bridge sends HTTP requests to it and broadcasts results/logs to WebSocket clients.
 * 
 * Usage in server.ts:
 *   import { DesktopBridge } from "./desktop-agent-bridge";
 *   const bridge = new DesktopBridge();
 *   // To execute an action:
 *   const result = await bridge.execute("open_application", { name: "chrome" });
 */

const DESKTOP_AGENT_URL = "http://localhost:3001";

export interface DesktopResult {
  success: boolean;
  action: string;
  result?: Record<string, unknown>;
  error?: string;
  needsConfirmation?: boolean;
  confirmationId?: string;
  timestamp?: string;
}

export interface DesktopStatus {
  connected: boolean;
  activeWindow: { title: string } | null;
  runningApps: Array<{ title: string; isActive?: boolean }>;
  systemInfo?: Record<string, unknown>;
  logs?: Array<{ id: number; timestamp: string; action: string; text: string; level: string }>;
}

export interface DesktopLog {
  id: number;
  timestamp: string;
  action: string;
  text: string;
  level: "info" | "success" | "warn" | "error" | "action";
}

type LogCallback = (log: DesktopLog) => void;
type StatusCallback = (status: DesktopStatus) => void;

export class DesktopBridge {
  private connected = false;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastStatus: DesktopStatus | null = null;
  private onLogCallbacks: LogCallback[] = [];
  private onStatusCallbacks: StatusCallback[] = [];

  constructor() {
    // Start polling immediately
    this.startPolling();
  }

  /**
   * Check if the Python sidecar is reachable.
   */
  async isConnected(): Promise<boolean> {
    try {
      const res = await fetch(`${DESKTOP_AGENT_URL}/api/status`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json() as DesktopStatus;
        this.connected = true;
        this.lastStatus = data;
        return true;
      }
    } catch {
      this.connected = false;
    }
    return false;
  }

  /**
   * Execute a desktop action on the Python sidecar.
   */
  async execute(action: string, args: Record<string, unknown> = {}): Promise<DesktopResult> {
    try {
      const res = await fetch(`${DESKTOP_AGENT_URL}/api/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: action, args }),
        signal: AbortSignal.timeout(30000), // 30s timeout for actions
      });

      if (!res.ok) {
        const text = await res.text();
        return { success: false, action, error: `Sidecar error ${res.status}: ${text}` };
      }

      const result = await res.json() as DesktopResult;
      return result;
    } catch (err: any) {
      return {
        success: false,
        action,
        error: err.message || "Cannot connect to Desktop Agent (is Python server running on port 3001?)",
      };
    }
  }

  /**
   * Get current desktop status (windows, system info, etc).
   */
  async getStatus(): Promise<DesktopStatus | null> {
    try {
      const res = await fetch(`${DESKTOP_AGENT_URL}/api/status`, {
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json() as DesktopStatus;
        this.lastStatus = data;
        return data;
      }
    } catch {
      this.connected = false;
    }
    return null;
  }

  /**
   * Get recent action logs.
   */
  async getLogs(): Promise<DesktopLog[]> {
    try {
      const res = await fetch(`${DESKTOP_AGENT_URL}/api/logs`, {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json() as { logs: DesktopLog[] };
        return data.logs;
      }
    } catch {
      // ignore
    }
    return [];
  }

  /**
   * Emergency block all desktop actions.
   */
  async block(reason: string = "User blocked"): Promise<void> {
    await fetch(`${DESKTOP_AGENT_URL}/api/block`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    }).catch(() => {});
  }

  /**
   * Resume desktop actions.
   */
  async unblock(): Promise<void> {
    await fetch(`${DESKTOP_AGENT_URL}/api/unblock`, {
      method: "POST",
    }).catch(() => {});
  }

  /**
   * Register a callback for new log entries.
   */
  onLog(callback: LogCallback): void {
    this.onLogCallbacks.push(callback);
  }

  /**
   * Register a callback for status changes.
   */
  onStatus(callback: StatusCallback): void {
    this.onStatusCallbacks.push(callback);
  }

  /**
   * Start polling the sidecar for status updates.
   * Runs every 4 seconds.
   */
  private startPolling(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);

    this.pollInterval = setInterval(async () => {
      const status = await this.getStatus();
      if (status) {
        // Notify status callbacks
        for (const cb of this.onStatusCallbacks) {
          try { cb(status); } catch {}
        }
      }
    }, 4000);

    // Initial check
    this.isConnected().catch(() => {});
  }

  /**
   * Stop polling.
   */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  getLastStatus(): DesktopStatus | null {
    return this.lastStatus;
  }
}
