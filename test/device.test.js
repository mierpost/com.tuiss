'use strict';

/**
 * Drives drivers/blind/device.js against a fake Homey runtime and a
 * simulated Tuiss motor, to exercise the connect/move/stop/retry logic
 * without hardware.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

// ---- fake `homey` module ---------------------------------------------------

class FakeDevice {

  constructor({ homey, data, settings = {}, store = {} }) {
    this.homey = homey;
    this._data = data;
    this._settings = {
      favorite_position: 50, invert: false, connect_attempts: 3, poll_interval: 0, battery_check_days: 0, ...settings,
    };
    this._store = { ...store };
    this._caps = {};
    this._listeners = {};
    this._available = true;
    this.logs = [];
  }

  log(...a) { this.logs.push(a.join(' ')); }

  error(...a) { this.logs.push(`ERR ${a.join(' ')}`); }

  getData() { return this._data; }

  getName() { return 'Test blind'; }

  getSetting(k) { return this._settings[k]; }

  async setSettings(s) { Object.assign(this._settings, s); }

  getStoreValue(k) { return this._store[k]; }

  async setStoreValue(k, v) { this._store[k] = v; }

  getCapabilityValue(k) { return this._caps[k]; }

  async setCapabilityValue(k, v) { this._caps[k] = v; }

  registerCapabilityListener(k, fn) { this._listeners[k] = fn; }

  getAvailable() { return this._available; }

  async setAvailable() { this._available = true; }

  /** Simulates the user changing a capability in the Homey UI. */
  async trigger(cap, value) {
    this._caps[cap] = value;
    return this._listeners[cap](value);
  }

}

const fakeHomeyModule = { Device: FakeDevice, Driver: class {}, App: class {} };
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return fakeHomeyModule;
  return originalLoad.call(this, request, ...rest);
};
const TuissBlindDevice = require('../drivers/blind/device');
const P = require('../lib/protocol');

// ---- simulated motor ------------------------------------------------------

function createMotor({ failConnects = 0, position = 0 } = {}) {
  const motor = {
    position, writes: [], connects: 0, failConnects, target: null, timer: null, notify: null,
  };

  const status = (pos) => Buffer.from([0xff, 0x78, 0xea, 0x41, 0xd2, 0x02, Math.round(pos), 0, 0]);

  const writeChar = {
    uuid: P.normalizeUuid(P.WRITE_CHARACTERISTIC_UUID),
    async write(data) {
      const h = data.toString('hex');
      motor.writes.push(h);
      if (h.startsWith(P.COMMANDS.SET_POSITION_BASE)) {
        motor.target = (data[6] + 256 * data[7]) / 10;
        if (!motor.timer) {
          motor.timer = setInterval(() => {
            const step = Math.sign(motor.target - motor.position) * Math.min(10, Math.abs(motor.target - motor.position));
            motor.position += step;
            motor.notify && motor.notify(status(motor.position));
            if (motor.position === motor.target) { clearInterval(motor.timer); motor.timer = null; }
          }, 5);
        }
      } else if (h === P.COMMANDS.STOP) {
        clearInterval(motor.timer); motor.timer = null;
      } else if (h === P.COMMANDS.GET_POSITION) {
        const v = Math.round(motor.position * 10);
        setImmediate(() => motor.notify && motor.notify(Buffer.from([0, 0, 0, 0, 0xd1, 0, 0, v % 256, Math.floor(v / 256)])));
      } else if (h === P.COMMANDS.BATTERY_STATUS) {
        setImmediate(() => motor.notify && motor.notify(Buffer.from([0xff, 0x78, 0xea, 0x41, 0xd2, 0x0c, 0x00])));
      }
      return Buffer.alloc(0);
    },
  };
  const notifyChar = {
    uuid: P.normalizeUuid(P.NOTIFY_CHARACTERISTIC_UUID),
    async subscribeToNotifications(cb) { motor.notify = cb; },
    async unsubscribeFromNotifications() { motor.notify = null; },
  };

  motor.advertisement = {
    uuid: 'aabbccddeeff',
    address: 'aa:bb:cc:dd:ee:ff',
    localName: 'TS3000',
    rssi: -60,
    async connect() {
      motor.connects++;
      if (motor.connects <= motor.failConnects) throw new Error('simulated connect failure');
      const peripheral = new EventEmitter();
      peripheral.isConnected = true;
      peripheral.discoverAllServicesAndCharacteristics = async () => [
        { uuid: '1800', characteristics: [] },
        { uuid: '000102030405060708090a0b0c0d1910', characteristics: [notifyChar, writeChar] },
      ];
      peripheral.disconnect = async () => { peripheral.isConnected = false; motor.notify = null; };
      return peripheral;
    },
  };
  return motor;
}

function createHomey(motor) {
  return {
    __: (key, tokens) => `${key}${tokens ? JSON.stringify(tokens) : ''}`,
    setTimeout: (fn, ms) => setTimeout(fn, ms / 100), // 120 s move timeout -> 1.2 s
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    ble: {
      async find(uuid) {
        if (uuid !== motor.advertisement.uuid) throw new Error('not found');
        return motor.advertisement;
      },
      async discover() { return [motor.advertisement]; },
    },
    flow: {},
  };
}

async function createDevice(motor, settings) {
  const homey = createHomey(motor);
  const device = new TuissBlindDevice({
    homey, data: { id: 'AA:BB:CC:DD:EE:FF', address: 'AA:BB:CC:DD:EE:FF' }, settings,
  });
  await device.onInit();
  return device;
}

const waitFor = async (cond, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 2));
  }
};

// ---- tests ----------------------------------------------------------------

test('open moves the motor to raw 100 and ends idle at position 1', async () => {
  const motor = createMotor();
  const device = await createDevice(motor);
  await device.trigger('windowcoverings_state', 'up');
  assert.deepStrictEqual(motor.writes.slice(0, 1), [P.COMMANDS.CONNECTION]);
  assert.ok(motor.writes[1].startsWith(P.COMMANDS.TIMESTAMP_BASE));
  assert.strictEqual(motor.writes[2], 'ff78ea41bf03e803');
  await waitFor(() => device.getCapabilityValue('windowcoverings_state') === 'idle');
  assert.strictEqual(device.getCapabilityValue('windowcoverings_set'), 1);
  assert.strictEqual(motor.position, 100);
  assert.strictEqual(device.getSetting('model'), 'TS3000');
});

test('invert setting flips direction', async () => {
  const motor = createMotor({ position: 100 });
  const device = await createDevice(motor, { invert: true });
  await device.trigger('windowcoverings_set', 1); // "open" in Homey -> raw 0
  assert.strictEqual(motor.writes[2], 'ff78ea41bf030000');
  await waitFor(() => device.getCapabilityValue('windowcoverings_state') === 'idle');
  assert.strictEqual(motor.position, 0);
  assert.strictEqual(device.getCapabilityValue('windowcoverings_set'), 1);
});

test('stop during a move uses the open connection, then re-reads position', async () => {
  const motor = createMotor();
  const device = await createDevice(motor);
  await device.trigger('windowcoverings_set', 1);
  await waitFor(() => motor.position >= 30);
  await device.trigger('windowcoverings_state', 'idle');
  assert.strictEqual(motor.connects, 1, 'stop must not open a second connection');
  assert.ok(motor.writes.includes(P.COMMANDS.STOP));
  const stoppedAt = motor.position;
  assert.ok(stoppedAt > 0 && stoppedAt < 100);
  await waitFor(() => motor.writes.includes(P.COMMANDS.GET_POSITION));
  await waitFor(() => device.getCapabilityValue('windowcoverings_set') === stoppedAt / 100);
});

test('new target during a move retargets on the same connection', async () => {
  const motor = createMotor();
  const device = await createDevice(motor);
  await device.trigger('windowcoverings_set', 1);
  await waitFor(() => motor.position >= 20);
  await device.trigger('windowcoverings_set', 0.5);
  await waitFor(() => device.getCapabilityValue('windowcoverings_state') === 'idle');
  assert.strictEqual(motor.connects, 1);
  assert.strictEqual(motor.position, 50);
  assert.strictEqual(device.getCapabilityValue('windowcoverings_set'), 0.5);
});

test('connection retries, then succeeds', async () => {
  const motor = createMotor({ failConnects: 2 });
  const device = await createDevice(motor);
  await device.trigger('windowcoverings_set', 0.3);
  await waitFor(() => device.getCapabilityValue('windowcoverings_state') === 'idle');
  assert.strictEqual(motor.connects, 3);
  assert.strictEqual(motor.position, 30);
});

test('gives up after the configured attempts with a clear error', async () => {
  const motor = createMotor({ failConnects: 99 });
  const device = await createDevice(motor, { connect_attempts: 2 });
  await assert.rejects(device.trigger('windowcoverings_set', 0.3), /errors\.connect_failed/);
  assert.strictEqual(motor.connects, 2);
});

test('battery check and position read', async () => {
  const motor = createMotor({ position: 40 });
  const device = await createDevice(motor);
  assert.strictEqual(await device.checkBattery(), true);
  assert.strictEqual(device.getCapabilityValue('alarm_battery'), true);
  assert.strictEqual(await device.refreshPosition(), 40);
  assert.strictEqual(device.getCapabilityValue('windowcoverings_set'), 0.4);
});

test('battery check piggybacks on a move when due', async () => {
  const motor = createMotor();
  const device = await createDevice(motor, { battery_check_days: 7 });
  await device.trigger('windowcoverings_set', 0.2);
  await waitFor(() => device.getCapabilityValue('windowcoverings_state') === 'idle');
  assert.strictEqual(motor.connects, 1);
  const bat = motor.writes.indexOf(P.COMMANDS.BATTERY_STATUS);
  const mv = motor.writes.findIndex((w) => w.startsWith(P.COMMANDS.SET_POSITION_BASE));
  assert.ok(bat !== -1 && bat < mv);
  assert.strictEqual(device.getCapabilityValue('alarm_battery'), true);
});

test('speed is refused for unsupported models, sent for supported', async () => {
  const motor = createMotor();
  const device = await createDevice(motor);
  device._store.model = 'TS3000';
  await assert.rejects(device.setSpeed('slow'), /speed_unsupported/);
  device._store.model = 'TS5200';
  await device.setSpeed('slow');
  assert.ok(motor.writes.includes(P.COMMANDS.SPEED_SLOW));
});

test('falls back to scanning when the peripheral uuid is unknown', async () => {
  const motor = createMotor();
  motor.advertisement.uuid = 'some-other-uuid';
  const device = await createDevice(motor);
  await device.refreshPosition();
  assert.strictEqual(device.getStoreValue('uuid'), 'some-other-uuid');
});
