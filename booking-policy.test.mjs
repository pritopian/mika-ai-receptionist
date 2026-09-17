import test from 'node:test';
import assert from 'node:assert/strict';
import { localDay, resolveBookingDay, clockContext, withinBusinessWindow, selectBookableService, selectTechnician } from './booking-policy.mjs';

const zone = 'America/Los_Angeles';
test('tomorrow uses the salon date, not the UTC date', () => {
  const now = new Date('2026-09-17T02:00:00Z');
  assert.equal(localDay(now, zone), '2026-09-16');
  assert.equal(resolveBookingDay('tomorrow', zone, now), '2026-09-17');
  assert.equal(resolveBookingDay('Friday', zone, now), '2026-09-18');
  assert.match(clockContext(zone, now), /Tomorrow is 2026-09-17/);
});
test('relative dates cross month, year and daylight saving boundaries', () => {
  assert.equal(resolveBookingDay('tomorrow', zone, new Date('2027-01-01T03:00:00Z')), '2027-01-01');
  assert.equal(resolveBookingDay('tomorrow', zone, new Date('2026-03-08T20:00:00Z')), '2026-03-09');
  assert.equal(resolveBookingDay('tomorrow', zone, new Date('2026-11-01T20:00:00Z')), '2026-11-02');
});
test('invalid and past dates are rejected', () => {
  const now = new Date('2026-01-01T20:00:00Z');
  for (const date of ['2026-02-30', '2025-12-31', 'next someday']) assert.throws(() => resolveBookingDay(date, zone, now));
});
test('both ends of an appointment must fit the business window', () => {
  const now = new Date('2026-09-16T12:00:00Z');
  const window = { start: new Date('2026-09-17T19:00:00Z'), end: new Date('2026-09-18T02:30:00Z') };
  const allowed = { start: '2026-09-18T02:00:00Z', end: '2026-09-18T02:30:00Z' };
  assert.equal(withinBusinessWindow(allowed, window, now), true);
  assert.equal(withinBusinessWindow({ ...allowed, end: '2026-09-18T02:31:00Z' }, window, now), false);
  assert.equal(withinBusinessWindow({ start: '2026-09-17T18:59:00Z', end: '2026-09-17T19:30:00Z' }, window, now), false);
  assert.equal(withinBusinessWindow(allowed, null, now), false);
  assert.equal(withinBusinessWindow(allowed, window, new Date('2026-09-19T00:00:00Z')), false);
  assert.equal(withinBusinessWindow({ ...allowed, start: 'invalid' }, window, now), false);
});
test('generic services use basic appointments without menu interrogation', () => {
  const catalog = ['Paua Regular Manicure', 'Paua Gel Manicure', 'Paua Express Pedicure', 'Paua Express Gel Pedicure', 'Paua Milk & Honey Pedicure'].map((name, id) => ({ name, id }));
  assert.equal(selectBookableService(catalog, 'manicure').name, 'Paua Regular Manicure');
  assert.equal(selectBookableService(catalog, 'pedi').name, 'Paua Express Pedicure');
  assert.throws(() => selectBookableService(catalog, 'manicure and pedicure'));
  assert.throws(() => selectBookableService([{ name: 'Unrelated sandbox item' }], 'pedicure'));
  assert.throws(() => selectBookableService([{ name: 'Gel Manicure' }], 'manicure'));
});
test('named technicians require one bookable match', () => {
  const people = [{ team_member_id: 'tm1', display_name: 'Alex', is_bookable: true }, { team_member_id: 'tm2', display_name: 'Sam', is_bookable: false }];
  assert.equal(selectTechnician(people, 'Alex'), 'tm1');
  assert.equal(selectTechnician(people, 'tm1'), 'tm1');
  assert.equal(selectTechnician(people, 'no preference'), '');
  assert.throws(() => selectTechnician(people, 'Sam'));
  assert.throws(() => selectTechnician([...people, { ...people[0], team_member_id: 'tm3' }], 'Alex'));
});
