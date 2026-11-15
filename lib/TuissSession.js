'use strict';

const {
  WRITE_CHARACTERISTIC_UUID,
  NOTIFY_CHARACTERISTIC_UUID,
  COMMANDS,
  normalizeUuid,
  command,
  buildTimestampCommand,
} = require('./protocol');

const WRITE_UUID = normalizeUuid(WRITE_CHARACTERISTIC_UUID);
const NOTIFY_UUID = normalizeUuid(NOTIFY_CHARACTERISTIC_UUID);

/**
 * One open BLE connection to a Tuiss motor.
 *
 * Notifications from the motor go to whichever handler is currently set
 * with `onNotify()`; `request()` temporarily installs a handler that
 * resolves once a matching reply arrives.
 */
class TuissSession {

  /**
   * @param {object} opts
   * @param {import('homey').BlePeripheral} opts.peripheral
   * @param {(...args: any[]) => void} opts.log
   */
  constructor({ peripheral, log }) {
    this.peripheral = peripheral;
    this.log = log;
    this.closed = false;
    this._handler = null;
    this._closeListeners = [];
    this._writeChar = null;
    this._notifyChar = null;
  }

  /**
   * Connects to an advertisement, resolves the characteristics, subscribes
   * to notifications and sends the connection + timestamp messages, exactly
   * like hub.py's connect().
   * @returns {Promise<TuissSession>}
   */
  static async open({ advertisement, log }) {
    const peripheral = await advertisement.connect();
    const session = new TuissSession({ peripheral, log });
    try {
      await session._setup();
    } catch (err) {
      await session.close();
      throw err;
    }
    return session;
  }

  async _setup() {
    this.peripheral.once('disconnect', () => this._markClosed('peripheral disconnected'));

    const services = await this.peripheral.discoverAllServicesAndCharacteristics();
    for (const service of services || []) {
      for (const characteristic of service.characteristics || []) {
        const uuid = normalizeUuid(characteristic.uuid);
        if (uuid === WRITE_UUID) this._writeChar = characteristic;
        if (uuid === NOTIFY_UUID) this._notifyChar = characteristic;
      }
    }
    if (!this._writeChar || !this._notifyChar) {
      const found = (services || []).map((s) => `${s.uuid}[${(s.characteristics || []).map((c) => c.uuid).join(',')}]`);
      throw new Error(`Tuiss characteristics not found on this device. Services: ${found.join(' ')}`);
    }

    await this._notifyChar.subscribeToNotifications((data) => {
      this.log('<-', Buffer.from(data).toString('hex'));
      if (this._handler) {
        try {
          this._handler(data);
        } catch (err) {
          this.log('Notification handler error:', err.message);
        }
      }
    });

    await this.write(command(COMMANDS.CONNECTION));
    await this.write(buildTimestampCommand());
  }

  /** @param {Buffer} data */
  async write(data) {
    if (this.closed) throw new Error('Connection to blind is closed');
    this.log('->', data.toString('hex'));
    await this._writeChar.write(data);
  }

  /** @param {((data: Buffer) => void) | null} handler */
  onNotify(handler) {
    this._handler = handler;
  }

  /** @param {(reason: string) => void} listener */
  onClose(listener) {
    if (this.closed) listener('already closed');
    else this._closeListeners.push(listener);
  }

  /**
   * Writes a command and waits for a reply that `parse` turns into a
   * non-null value.
   * @template T
   * @param {Buffer} data
   * @param {(data: Buffer) => T | null} parse
   * @param {number} [timeoutMs]
   * @returns {Promise<T>}
   */
  request(data, parse, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      let done = false;
      const previous = this._handler;
      const finish = (err, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._handler = previous;
        if (err) reject(err);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('No response from blind')), timeoutMs);
      this._handler = (reply) => {
        const value = parse(reply);
        if (value !== null && value !== undefined) finish(null, value);
      };
      this.onClose(() => finish(new Error('Connection to blind closed')));
      this.write(data).catch((err) => finish(err));
    });
  }

  _markClosed(reason) {
    if (this.closed) return;
    this.closed = true;
    this._handler = null;
    const listeners = this._closeListeners;
    this._closeListeners = [];
    for (const listener of listeners) listener(reason);
  }

  async close() {
    const wasOpen = !this.closed;
    this._markClosed('closed by app');
    if (!wasOpen && !this.peripheral.isConnected) return;
    try {
      if (this._notifyChar) await this._notifyChar.unsubscribeFromNotifications().catch(() => {});
      await this.peripheral.disconnect();
    } catch (err) {
      this.log('Disconnect error (ignored):', err.message);
    }
  }

}

module.exports = TuissSession;
