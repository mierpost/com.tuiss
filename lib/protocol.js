'use strict';

/**
 * Tuiss SmartView (and Blinds2go) BLE protocol.
 *
 * Ported from the Home Assistant integration Tuiss2HA by pink88
 * (https://github.com/pink88/Tuiss2HA, const.py + protocol.py + hub.py).
 *
 * Position scale
 * --------------
 * The raw value the motor uses is 0 = fully closed, 100 = fully open.
 * Tuiss2HA describes it as "inverted", but it inverts twice on the way to
 * the motor (cover.py: 100 - pos, protocol.py: 100 - that), so the net raw
 * value equals Home Assistant's own 0-100 position (100 = open). Homey's
 * windowcoverings_set uses the same orientation (0 = closed, 1 = open).
 */

const WRITE_CHARACTERISTIC_UUID = '00010405-0405-0607-0809-0a0b0c0d1910';
const NOTIFY_CHARACTERISTIC_UUID = '00010304-0405-0607-0809-0a0b0c0d1910';

/** Local names the motors advertise (Tuiss2HA manifest.json). */
const KNOWN_MODELS = ['TS3000', 'TS5200', 'TS5001', 'TS5101', 'TS5300', 'TS2600', 'TS2900'];

/** Models that accept the speed command (const.py SPEED_CONTROL_SUPPORTED_MODELS). */
const SPEED_SUPPORTED_MODELS = ['TS5200', 'TS5101', 'TS5001', 'TS2600'];

const COMMANDS = {
  CONNECTION: 'ff03030303787878787878',
  GET_POSITION: 'ff78ea41d10301', // INITIALIZATION_MESSAGE in Tuiss2HA
  STOP: 'ff78ea415f0301',
  BATTERY_STATUS: 'ff78ea41f00301',
  SPEED_STANDARD: 'ff78ea41f202',
  SPEED_COMFORT: 'ff78ea41f201',
  SPEED_SLOW: 'ff78ea41f200',
  TIMESTAMP_BASE: 'ff78ea410200',
  SET_POSITION_BASE: 'ff78ea41bf03',
};

const SPEED_COMMANDS = {
  standard: COMMANDS.SPEED_STANDARD,
  comfort: COMMANDS.SPEED_COMFORT,
  slow: COMMANDS.SPEED_SLOW,
};

/** Response marker byte (index 4) for battery and movement notifications. */
const STATUS_MARKER = 0xd2;

const hex2 = (n) => n.toString(16).padStart(2, '0');

/** Normalises a UUID for comparison: lowercase, no dashes. */
function normalizeUuid(uuid) {
  return String(uuid || '').toLowerCase().replace(/-/g, '');
}

/** Normalises a MAC address to AA:BB:CC:DD:EE:FF, or returns null if invalid. */
function normalizeMac(input) {
  const hex = String(input || '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) return null;
  return hex.toUpperCase().match(/.{2}/g).join(':');
}

/** Whether a BLE local name looks like a Tuiss motor. */
function isTuissName(localName) {
  const name = String(localName || '').toUpperCase();
  return KNOWN_MODELS.some((m) => name.startsWith(m)) || /^TS\d{4}/.test(name) || name.includes('TUISS');
}

function supportsSpeed(model) {
  const name = String(model || '').toUpperCase();
  return SPEED_SUPPORTED_MODELS.some((m) => name.startsWith(m));
}

/**
 * Builds the set-position command.
 * @param {number} rawPercent 0-100 on the motor scale (0 = closed, 100 = open)
 * @returns {Buffer}
 */
function buildSetPositionCommand(rawPercent) {
  const clamped = Math.min(100, Math.max(0, Number(rawPercent)));
  const total = Math.round(clamped * 10);
  return Buffer.from(`${COMMANDS.SET_POSITION_BASE}${hex2(total % 256)}${hex2(Math.floor(total / 256))}`, 'hex');
}

/**
 * Builds the timestamp command the motor expects right after connecting.
 * @param {Date} [now]
 * @returns {Buffer}
 */
function buildTimestampCommand(now = new Date()) {
  return Buffer.from(
    COMMANDS.TIMESTAMP_BASE
      + hex2(now.getFullYear() - 2000)
      + hex2(now.getMonth() + 1)
      + hex2(now.getDate())
      + hex2(now.getHours())
      + hex2(now.getMinutes())
      + hex2(now.getSeconds()),
    'hex',
  );
}

/** @returns {Buffer} */
function command(hex) {
  return Buffer.from(hex, 'hex');
}

/**
 * Battery reply (hub.py battery_callback).
 * @param {Buffer} data
 * @returns {'good'|'low'|null} null when this is not a battery reply
 */
function parseBatteryResponse(data) {
  const b = Array.from(data);
  if (b.length <= 4 || b[4] !== STATUS_MARKER) return null;
  if (b.length < 6 || b[5] >= 10) return 'low';
  return 'good';
}

/**
 * Reply to GET_POSITION (hub.py position_callback).
 * @param {Buffer} data
 * @returns {number|null} raw position 0-100, or null when not a position packet
 */
function parsePositionResponse(data) {
  const b = Array.from(data);
  if (b.length < 9) return null;
  const pos = (b[7] + 256 * b[8]) / 10;
  return pos >= 0 && pos <= 100 ? pos : null;
}

/**
 * Progress notification while moving (hub.py set_position_callback).
 * @param {Buffer} data
 * @returns {number|null} raw position 0-100, or null
 */
function parseMovementResponse(data) {
  const b = Array.from(data);
  if (b.length >= 9 && b[4] === STATUS_MARKER && b[6] <= 100) return b[6];
  return null;
}

module.exports = {
  WRITE_CHARACTERISTIC_UUID,
  NOTIFY_CHARACTERISTIC_UUID,
  KNOWN_MODELS,
  SPEED_SUPPORTED_MODELS,
  COMMANDS,
  SPEED_COMMANDS,
  normalizeUuid,
  normalizeMac,
  isTuissName,
  supportsSpeed,
  command,
  buildSetPositionCommand,
  buildTimestampCommand,
  parseBatteryResponse,
  parsePositionResponse,
  parseMovementResponse,
};
