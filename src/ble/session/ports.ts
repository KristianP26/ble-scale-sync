export interface BleChar {
  /** Subscribe to notifications. Returns an unsubscribe function to remove the listener. */
  subscribe(onData: (data: Buffer) => void): Promise<() => void>;
  write(data: Buffer, withResponse: boolean): Promise<void>;
  read(): Promise<Buffer>;
  /**
   * Turn notifications/indications off on the peer (CCCD back to 0).
   *
   * The unsubscribe function `subscribe` returns only drops our listener; the
   * CCCD stays enabled until the link goes down. Only the node-ble transport
   * implements this, and only `stopDeferredNotifications` calls it.
   */
  stop?(): Promise<void>;
}

export interface BleDevice {
  onDisconnect(callback: () => void): void;
  /**
   * Abandon this session locally, as if the peer had reported a disconnect.
   *
   * `waitForRawReading()` only settles on a reading, a subscribe failure or a
   * disconnect, so a caller whose own timeout gives up abandons the promise and
   * nothing it holds is released: the legacy unlock `setInterval` keeps writing
   * through a dead link for the life of the process, the notify unsubscribers
   * are never run, and `adapter.onSessionEnd()` is never called (#404).
   *
   * Calling this drives the existing disconnect path, so there is exactly one
   * cleanup route rather than one per transport. Idempotent: a real disconnect
   * arriving afterwards does nothing.
   */
  fireDisconnect(): void;
}
