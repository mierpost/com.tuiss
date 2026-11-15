'use strict';

const Homey = require('homey');
const TuissSession = require('../../lib/TuissSession');
const {
  COMMANDS,
  SPEED_COMMANDS,
  command,
  normalizeMac,
  normalizeUuid,
  supportsSpeed,
  buildSetPositionCommand,
  parseBatteryResponse,
  parsePositionResponse,
  parseMovementResponse,
} = require('../../lib/protocol');

/** Same tolerance as Tuiss2HA's set_position_callback (raw scale). */
const POSITION_TOLERANCE = 2;
/** Tuiss2HA TIMEOUT_SECONDS. */
const MOVE_TIMEOUT_MS = 120 * 1000;
const RETRY_DELAY_MS = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

class TuissBlindDevice extends Homey.Device {

  async onInit() {
    this._queue = Promise.resolve();
    this._move = null;
    this._pollTimer = null;
    this._positionQueryTimer = null;

    this.registerCapabilityListener('windowcoverings_set', (value) => this._moveTo(value));
    this.registerCapabilityListener('windowcoverings_state', (value) => {
      if (value === 'up') return this._moveTo(1);
      if (value === 'down') return this._moveTo(0);
      return this.stop();
    });

    const { address } = this.getData();
    if (this.getSetting('address') !== address) {
      await this.setSettings({ address }).catch(this.error);
    }

    this._setupPolling();
    this.log('Initialised', this.getName(), address);
  }

  async onUninit() {
    this._teardown();
  }

  async onDeleted() {
    this._teardown();
  }

  _teardown() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    if (this._positionQueryTimer) this.homey.clearTimeout(this._positionQueryTimer);
    this._pollTimer = null;
    this._positionQueryTimer = null;
    if (this._move) {
      this._move.finish('device removed');
      this._move.session.close().catch(() => {});
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('speed')) {
      await this.setSpeed(newSettings.speed);
    }
    if (changedKeys.includes('poll_interval')) {
      this.homey.setTimeout(() => this._setupPolling(), 0);
    }
  }

  // ---------------------------------------------------------------------------
  // Public actions (capabilities + Flow cards)
  // ---------------------------------------------------------------------------

  async stop() {
    const move = this._move;
    if (move && !move.session.closed) {
      if (move.started) await move.session.write(command(COMMANDS.STOP));
      move.finish('stopped');
      return;
    }
    // Not moving through us (e.g. started with the remote): connect just to stop.
    await this._withSession((session) => session.write(command(COMMANDS.STOP)));
    this._schedulePositionQuery(2000);
  }

  async goToFavorite() {
    const favorite = Number(this.getSetting('favorite_position'));
    const value = Number.isFinite(favorite) ? favorite / 100 : 0.5;
    await this.setCapabilityValue('windowcoverings_set', value).catch(this.error);
    await this._moveTo(value);
  }

  async refreshPosition() {
    return this._withSession(async (session) => {
      const raw = await session.request(command(COMMANDS.GET_POSITION), parsePositionResponse);
      await this._reportRawPosition(raw);
      return raw;
    });
  }

  /** @returns {Promise<boolean>} true when the battery is low */
  async checkBattery() {
    return this._withSession((session) => this._readBattery(session));
  }

  /** @param {'standard'|'comfort'|'slow'} speed */
  async setSpeed(speed) {
    const hex = SPEED_COMMANDS[speed];
    if (!hex) throw new Error(this.homey.__('errors.unknown_speed', { speed }));
    const model = this.getStoreValue('model');
    if (model && !supportsSpeed(model)) {
      throw new Error(this.homey.__('errors.speed_unsupported', { model }));
    }
    await this._withSession((session) => session.write(command(hex)));
  }

  // ---------------------------------------------------------------------------
  // Movement
  // ---------------------------------------------------------------------------

  /**
   * Starts moving to a Homey position (0 = closed, 1 = open). Resolves as
   * soon as the motor has accepted the command; the connection stays open in
   * the background to follow progress until the target is reached.
   */
  async _moveTo(value) {
    const raw = this._toRaw(value);

    // Already moving through an open connection: retarget on the fly.
    const move = this._move;
    if (move && !move.session.closed) {
      move.target = raw;
      if (move.started) await move.session.write(buildSetPositionCommand(raw));
      return;
    }

    if (this._positionQueryTimer) {
      this.homey.clearTimeout(this._positionQueryTimer);
      this._positionQueryTimer = null;
    }

    await new Promise((resolve, reject) => {
      this._exclusive(() => this._runMove(raw, resolve))
        .then(resolve, (err) => {
          this.error('Move failed:', err.message);
          reject(err);
        });
    });
  }

  async _runMove(raw, onStarted) {
    const session = await this._openSession();
    const move = {
      session, target: raw, started: false, ended: null,
    };
    const done = new Promise((resolve) => {
      move.finish = (why) => {
        if (!move.ended) move.ended = why;
        resolve(move.ended);
      };
    });
    session.onClose(() => move.finish('connection closed'));
    this._move = move;

    let timer = null;
    let reason;
    try {
      await this._maybeCheckBattery(session);
      if (move.ended) {
        // Stopped (or removed) before the motor was told to move.
        onStarted();
        reason = move.ended;
        return;
      }

      session.onNotify((data) => {
        const pos = parseMovementResponse(data);
        if (pos === null) return;
        this._reportRawPosition(pos).catch(this.error);
        if (Math.abs(pos - move.target) <= POSITION_TOLERANCE) move.finish('reached');
      });
      await session.write(buildSetPositionCommand(move.target));
      move.started = true;
      onStarted();

      reason = await Promise.race([
        done,
        new Promise((resolve) => { timer = this.homey.setTimeout(() => resolve('timeout'), MOVE_TIMEOUT_MS); }),
      ]);
      this.log(`Move to ${move.target} ended: ${reason}`);
      if (reason === 'reached') await this._reportRawPosition(move.target).catch(this.error);
    } finally {
      if (timer) this.homey.clearTimeout(timer);
      if (this._move === move) this._move = null;
      await session.close();
      await this.setCapabilityValue('windowcoverings_state', 'idle').catch(this.error);
      if (move.started && reason !== 'reached' && reason !== 'device removed') {
        this._schedulePositionQuery(3000);
      }
    }
  }

  _schedulePositionQuery(delayMs) {
    if (this._positionQueryTimer) this.homey.clearTimeout(this._positionQueryTimer);
    this._positionQueryTimer = this.homey.setTimeout(() => {
      this._positionQueryTimer = null;
      this.refreshPosition().catch((err) => this.log('Position query failed:', err.message));
    }, delayMs);
  }

  // ---------------------------------------------------------------------------
  // Battery
  // ---------------------------------------------------------------------------

  async _readBattery(session) {
    const status = await session.request(command(COMMANDS.BATTERY_STATUS), parseBatteryResponse);
    const low = status === 'low';
    await this.setCapabilityValue('alarm_battery', low).catch(this.error);
    await this.setStoreValue('last_battery_check', Date.now()).catch(this.error);
    this.log('Battery:', status);
    return low;
  }

  /** Battery check piggybacking on a move connection, like Tuiss2HA's battery_check_days. */
  async _maybeCheckBattery(session) {
    const days = Number(this.getSetting('battery_check_days')) || 0;
    if (days <= 0) return;
    const last = Number(this.getStoreValue('last_battery_check')) || 0;
    if (Date.now() - last < days * DAY_MS) return;
    try {
      await this._readBattery(session);
    } catch (err) {
      this.log('Battery check failed (continuing with move):', err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  _setupPolling() {
    if (this._pollTimer) this.homey.clearInterval(this._pollTimer);
    this._pollTimer = null;
    const minutes = Number(this.getSetting('poll_interval')) || 0;
    if (minutes <= 0) return;

    const poll = () => {
      if (this._move) return;
      this.refreshPosition().catch((err) => this.log('Poll failed:', err.message));
    };
    this._pollTimer = this.homey.setInterval(poll, minutes * 60 * 1000);
    // Stagger the first poll so several blinds don't all connect at once.
    this.homey.setTimeout(poll, 5000 + Math.floor(Math.random() * 20000));
  }

  // ---------------------------------------------------------------------------
  // Connection handling
  // ---------------------------------------------------------------------------

  /** Runs tasks that need the radio one at a time. */
  _exclusive(fn) {
    const result = this._queue.then(() => fn());
    this._queue = result.catch(() => {});
    return result;
  }

  /** Opens a connection, runs `fn(session)`, always disconnects. */
  _withSession(fn) {
    return this._exclusive(async () => {
      const session = await this._openSession();
      try {
        return await fn(session);
      } finally {
        await session.close();
      }
    });
  }

  async _openSession() {
    const attempts = Math.max(1, Math.round(Number(this.getSetting('connect_attempts')) || 3));
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const advertisement = await this._findAdvertisement();
        this._rememberAdvertisement(advertisement);
        const session = await TuissSession.open({
          advertisement,
          log: (...args) => this.log(...args),
        });
        if (!this.getAvailable()) await this.setAvailable().catch(this.error);
        return session;
      } catch (err) {
        lastError = err;
        this.log(`Connect attempt ${attempt}/${attempts} failed:`, err.message);
        if (attempt < attempts) await new Promise((r) => this.homey.setTimeout(r, RETRY_DELAY_MS));
      }
    }
    throw new Error(this.homey.__('errors.connect_failed', { error: lastError ? lastError.message : '?' }));
  }

  async _findAdvertisement() {
    const { address } = this.getData();
    const mac = normalizeMac(address);
    // On Homey the peripheral UUID is normally the MAC without colons, lowercase.
    const uuid = this.getStoreValue('uuid') || mac.replace(/:/g, '').toLowerCase();

    try {
      const advertisement = await this.homey.ble.find(uuid);
      if (advertisement) return advertisement;
    } catch (err) {
      this.log('Direct lookup failed, scanning:', err.message);
    }

    const advertisements = await this.homey.ble.discover();
    const match = advertisements.find((adv) => normalizeUuid(adv.uuid) === normalizeUuid(uuid)
      || normalizeMac(adv.address) === mac);
    if (!match) throw new Error(this.homey.__('errors.not_found'));
    return match;
  }

  _rememberAdvertisement(advertisement) {
    const updates = {};
    if (advertisement.uuid && advertisement.uuid !== this.getStoreValue('uuid')) {
      this.setStoreValue('uuid', advertisement.uuid).catch(this.error);
    }
    if (advertisement.localName && advertisement.localName !== this.getStoreValue('model')) {
      this.setStoreValue('model', advertisement.localName).catch(this.error);
      updates.model = advertisement.localName;
    }
    if (typeof advertisement.rssi === 'number') updates.rssi = `${advertisement.rssi} dBm`;
    if (Object.keys(updates).length) this.setSettings(updates).catch(this.error);
  }

  // ---------------------------------------------------------------------------
  // Position scale helpers
  // ---------------------------------------------------------------------------

  /** Homey 0..1 → raw motor 0..100 (0 = closed, 100 = open). */
  _toRaw(value) {
    const pct = Math.min(100, Math.max(0, Number(value) * 100));
    return this.getSetting('invert') ? 100 - pct : pct;
  }

  /** Raw motor 0..100 → Homey 0..1. */
  _fromRaw(raw) {
    const value = Number(raw) / 100;
    return Math.round((this.getSetting('invert') ? 1 - value : value) * 100) / 100;
  }

  async _reportRawPosition(raw) {
    await this.setCapabilityValue('windowcoverings_set', this._fromRaw(raw));
  }

}

module.exports = TuissBlindDevice;
