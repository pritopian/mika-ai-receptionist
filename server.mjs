import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { google } from 'googleapis';
import twilio from 'twilio';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, '.data');
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || process.env.VOICE_SERVER_PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const salonName = process.env.SALON_NAME || 'the salon';
const salonAddress = process.env.SALON_ADDRESS || '';
const timezone = process.env.SALON_TIMEZONE || 'America/Los_Angeles';
const bookingBufferMinutes = 15;
const openDays = new Set(String(process.env.SALON_OPEN_DAYS || '1,2,3,4,5,6').split(',').map(value => Number(value.trim())).filter(Number.isInteger));
const openTime = String(process.env.SALON_OPEN_TIME || '10:00').split(':').map(Number);
const closeTime = String(process.env.SALON_CLOSE_TIME || '19:00').split(':').map(Number);
const defaultPauaHours = { 0: ['10:00', '17:30'], 1: ['11:00', '19:30'], 2: ['13:00', '19:30'], 3: ['12:00', '19:30'], 4: ['12:00', '19:30'], 5: ['11:00', '19:30'], 6: ['10:00', '17:30'] };
const weeklyHours = (() => {
  try { return JSON.parse(process.env.SALON_HOURS_JSON || ( /paua/i.test(salonName) ? JSON.stringify(defaultPauaHours) : 'null' )); } catch { return null; }
})();
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;
const squareEnvironment = process.env.SQUARE_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production';
const squareApiBase = squareEnvironment === 'sandbox' ? 'https://connect.squareupsandbox.com/v2' : 'https://connect.squareup.com/v2';
const squareOauthBase = squareEnvironment === 'sandbox' ? 'https://connect.squareupsandbox.com/oauth2' : 'https://connect.squareup.com/oauth2';
const squareApiVersion = process.env.SQUARE_API_VERSION || '2026-08-19';

const pauaServices = [
  { category: 'Manicure', name: 'Paua Regular Manicure', price: '$32', duration: '30 min' },
  { category: 'Manicure', name: 'Paua Gel Manicure', price: '$49', duration: '45 min' },
  { category: 'Manicure', name: 'Soft Gel Manicure', price: '$65', duration: '1 hr' },
  { category: 'Manicure', name: 'Hard Gel Manicure', price: '$65', duration: '1 hr 30 min' },
  { category: 'Manicure', name: 'Dip Manicure', price: '$65', duration: '1 hr' },
  { category: 'Manicure', name: 'Fill Mani', price: '$65', duration: '1 hr 15 min' },
  { category: 'Manicure', name: 'Fullset Dip or Hard Gel Manicure', price: '$75', duration: '1 hr 45 min' },
  { category: 'Manicure', name: 'GelX Manicure', price: '$85', duration: '1 hr 30 min' },
  { category: 'Pedicure', name: 'Paua Express Pedicure', price: '$45', duration: '30 min' },
  { category: 'Pedicure', name: 'Paua Express Gel Pedicure', price: '$55', duration: '35 min' },
  { category: 'Pedicure', name: 'Paua Milk & Honey Pedicure', price: '$75', duration: '1 hr' },
  { category: 'Pedicure', name: 'Paua Blissful Bloom Pedicure', price: '$75', duration: '1 hr' },
  { category: 'Pedicure', name: 'Paua Zesty Oasis Pedicure', price: '$75', duration: '1 hr' },
  { category: 'Nail art & removal', name: 'Nail Art - Tier 1', price: '$15', duration: '10 min' },
  { category: 'Nail art & removal', name: 'Nail Art - Tier 2', price: '$25', duration: '20 min' },
  { category: 'Nail art & removal', name: 'Nail Art - Tier 3', price: '$35+', duration: '30 min' },
  { category: 'Nail art & removal', name: 'Gel / Soft Gel Removal', price: '$15', duration: '10 min' },
  { category: 'Nail art & removal', name: 'Dip/Acrylic/GelX Removal', price: '$25', duration: '30 min' },
  { category: 'Repairs', name: 'Fix Nail', price: '$10', duration: '30 min' },
  { category: 'Repairs', name: 'Fix Nail / Add a tip', price: '$5', duration: '5 min' }
];

const defaultPauaProfile = { website: 'https://pauabeautylounge.booksy.com/', name: 'Paua Beauty Lounge', title: 'Paua Beauty Lounge', description: 'Nail salon appointments handled by Mika.', address: '1455 Powell St, San Francisco, CA 94133', phone: '(415) 525-4766', hours: 'Sunday 10 AM-5:30 PM; Monday 11 AM-7:30 PM; Tuesday 1-7:30 PM; Wednesday 12-7:30 PM; Thursday 12-7:30 PM; Friday 11 AM-7:30 PM; Saturday 10 AM-5:30 PM', services: pauaServices, status: 'confirmed' };

function requestPublicBaseUrl(req) {
  const forwardedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const forwardedProto = String(req.headers['x-forwarded-proto'] || (forwardedHost.includes('localhost') ? 'http' : 'https')).split(',')[0].trim();
  return `${forwardedProto}://${forwardedHost}`.replace(/\/$/, '');
}

await fs.mkdir(dataDir, { recursive: true });
const promptTemplate = await fs.readFile(path.join(root, 'REALTIME_PROMPT.md'), 'utf8').catch(() => 'You are Mika, a warm AI receptionist for {{SALON_NAME}}.');

async function appendLog(entry) {
  const logFile = path.join(dataDir, 'activity.json');
  let entries = [];
  try { entries = JSON.parse(await fs.readFile(logFile, 'utf8')); } catch {}
  const durableEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), ...entry };
  entries.unshift(durableEntry);
  await fs.writeFile(logFile, JSON.stringify(entries.slice(0, 200), null, 2));
  void logActivityToSheet(durableEntry);
}

async function readLogs() {
  let localEntries = [];
  try { localEntries = JSON.parse(await fs.readFile(path.join(dataDir, 'activity.json'), 'utf8')); } catch {}
  try {
    const { sheets } = await calendar();
    const spreadsheetId = await ensureBookingSheet(sheets);
    const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Activity!A2:G200' });
    const remoteEntries = (response.data.values || []).map(row => ({ at: row[0], type: row[1], customer: row[2], service: row[3], status: row[4], channel: row[5], details: row[6] }));
    if (remoteEntries.length) return remoteEntries.sort((a, b) => new Date(b.at) - new Date(a.at));
  } catch {}
  return localEntries;
}

async function readProfile() {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, 'salon-profile.json'), 'utf8')); } catch { return {}; }
}

async function activeSalonProfile() {
  const profile = await readProfile();
  if (/paua/i.test(salonName)) {
    const activePaua = { ...defaultPauaProfile, ...profile, services: profile.services?.length ? profile.services : pauaServices, address: profile.address || defaultPauaProfile.address, phone: profile.phone || defaultPauaProfile.phone, hours: profile.hours || defaultPauaProfile.hours };
    globalThis.__mikaProfile = activePaua;
    return activePaua;
  }
  const active = profile.status === 'confirmed' ? profile : { ...profile, name: profile.name || salonName, address: profile.address || salonAddress };
  globalThis.__mikaProfile = active;
  return active;
}

async function logActivityToSheet(entry) {
  try {
    const { sheets } = await calendar();
    const spreadsheetId = await ensureBookingSheet(sheets);
    try { await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: 'Activity' } } }] } }); } catch {}
    try { await sheets.spreadsheets.values.update({ spreadsheetId, range: 'Activity!A1:G1', valueInputOption: 'RAW', requestBody: { values: [['Created', 'Type', 'Customer', 'Service', 'Status', 'Channel', 'Details']] } }); } catch {}
    await sheets.spreadsheets.values.append({ spreadsheetId, range: 'Activity!A:G', valueInputOption: 'USER_ENTERED', requestBody: { values: [[new Date().toISOString(), entry.type, entry.customer || '', entry.service || '', entry.status || '', entry.channel || '', entry.details || '']] } });
  } catch (error) { console.error(`Activity sheet: ${error.message}`); }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  if (String(req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(body));
  return JSON.parse(body);
};

const requestRedirectUri = req => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const protocol = String(req.headers['x-forwarded-proto'] || (host?.includes('localhost') ? 'http' : 'https')).split(',')[0];
  return `${protocol}://${host}/api/google/callback`;
};

const squareRedirectUri = req => process.env.SQUARE_REDIRECT_URI || `${requestPublicBaseUrl(req)}/api/square/callback`;

const oauthClient = (redirectUri = process.env.GOOGLE_REDIRECT_URI) => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectUri
);

async function readToken() {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, 'google-token.json'), 'utf8')); }
  catch { return process.env.GOOGLE_REFRESH_TOKEN ? { refresh_token: process.env.GOOGLE_REFRESH_TOKEN } : null; }
}

async function readSquareToken() {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, 'square-token.json'), 'utf8')); }
  catch { return process.env.SQUARE_ACCESS_TOKEN ? { access_token: process.env.SQUARE_ACCESS_TOKEN } : null; }
}

async function squareAccessToken() {
  const token = await readSquareToken();
  return token?.access_token || null;
}

async function squareConnected() { return Boolean(await squareAccessToken()); }

async function squareRequest(endpoint, options = {}) {
  const accessToken = await squareAccessToken();
  if (!accessToken) throw new Error('Square is not connected yet.');
  const response = await fetch(`${squareApiBase}${endpoint}`, {
    ...options,
    headers: { 'Square-Version': squareApiVersion, Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.errors?.map(error => error.detail || error.code).join('; ') || `Square request failed (${response.status}).`);
  return payload;
}

async function squareProfile() {
  const payload = await squareRequest('/locations');
  const location = (payload.locations || []).find(item => !process.env.SQUARE_LOCATION_ID || item.id === process.env.SQUARE_LOCATION_ID) || payload.locations?.[0];
  if (!location) throw new Error('No Square location was found.');
  return { locationId: location.id, name: location.business_name || salonName, address: [location.address?.address_line_1, location.address?.locality, location.address?.administrative_district_level_1, location.address?.postal_code].filter(Boolean).join(', ') };
}

async function squareServices() {
  const payload = await squareRequest('/catalog/list?types=ITEM');
  return (payload.objects || []).flatMap(item => (item.item_data?.variations || []).map(variation => ({
    id: variation.id,
    version: variation.version,
    category: 'Square service',
    name: variation.item_variation_data?.name || item.item_data?.name || 'Salon service',
    price: variation.item_variation_data?.price_money ? `$${(variation.item_variation_data.price_money.amount / 100).toFixed(2)}` : '',
    duration: variation.item_variation_data?.service_duration ? `${Math.round(variation.item_variation_data.service_duration / 60000)} min` : ''
  })));
}

async function squareAvailability({ date, service, requestedTime = '', technician = '' }) {
  const profile = await squareProfile();
  const services = await squareServices();
  const query = String(service || '').toLowerCase();
  const selected = services.find(item => item.name.toLowerCase() === query) || services.find(item => query.includes(item.name.toLowerCase()) || item.name.toLowerCase().includes(query));
  if (!selected) throw new Error(`Square service not found: ${service}`);
  const day = date || new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const start = toDateTime(day, 0, 0).toISOString();
  const end = new Date(toDateTime(day, 23, 59).getTime()).toISOString();
  const payload = await squareRequest('/bookings/availability/search', { method: 'POST', body: JSON.stringify({ query: { filter: { start_at_range: { start_at: start, end_at: end }, location_id: profile.locationId, segment_filters: [{ service_variation_id: selected.id, ...(technician ? { team_member_id_filter: { any: [technician] } } : {}) }] } } }) });
  let slots = (payload.availabilities || []).map(item => ({ start: item.start_at, end: new Date(new Date(item.start_at).getTime() + Number(item.appointment_segments?.[0]?.duration_minutes || 60) * 60000).toISOString(), label: salonTimeLabel(item.start_at), technician: item.appointment_segments?.[0]?.team_member_id || 'available team member', squareServiceId: selected.id, squareServiceVersion: selected.version }));
  const requestedMinutes = /^\d{1,2}:\d{2}$/.test(requestedTime) ? requestedTime.split(':').map(Number).reduce((hour, minute) => hour * 60 + minute) : null;
  if (requestedMinutes !== null) slots.sort((a, b) => Math.abs(Number(localDateParts(new Date(a.start)).hour) * 60 + Number(localDateParts(new Date(a.start)).minute) - requestedMinutes) - Math.abs(Number(localDateParts(new Date(b.start)).hour) * 60 + Number(localDateParts(new Date(b.start)).minute) - requestedMinutes));
  return { source: 'square', date: day, service: selected.name, durationMinutes: Number(selected.duration.match(/\d+/)?.[0] || 60), slots: slots.slice(0, 3), locationId: profile.locationId };
}

async function squareBooking(booking) {
  const profile = await squareProfile();
  const customer = await squareRequest('/customers', { method: 'POST', body: JSON.stringify({ given_name: booking.customerName, phone_number: booking.phone }) });
  return squareRequest('/bookings', { method: 'POST', body: JSON.stringify({ idempotency_key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, booking: { customer_id: customer.customer?.id, start_at: booking.start, location_id: booking.locationId || profile.locationId, appointment_segments: [{ duration_minutes: Math.round((new Date(booking.end) - new Date(booking.start)) / 60000), team_member_id: booking.technician, service_variation_id: booking.squareServiceId, service_variation_version: booking.squareServiceVersion }] } }) });
}

async function squareOAuthToken(params) {
  const response = await fetch(`${squareOauthBase}/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: process.env.SQUARE_APPLICATION_ID, client_secret: process.env.SQUARE_APPLICATION_SECRET, ...params }) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.message || payload.errors?.map(error => error.detail || error.code).join('; ') || 'Square authorization failed.');
  return payload;
}

async function googleAuth() {
  const token = await readToken();
  if (!token) return null;
  const auth = oauthClient();
  auth.setCredentials(token);
  return auth;
}

function serviceDetails(service = '', gel = false) {
  const value = service.toLowerCase();
  const profile = globalThis.__mikaProfile || {};
  const combined = ['pedicure', 'manicure'].filter(kind => value.includes(kind));
  if (combined.length === 2) return { label: 'pedicure and manicure', durationMinutes: 90 };
  const catalogMatch = (profile.services || []).find(item => typeof item === 'object' && String(item.name || '').toLowerCase() === value);
  const catalogMinutes = catalogMatch?.duration?.match(/(\d+)\s*hr/) ? Number(catalogMatch.duration.match(/(\d+)\s*hr/)[1]) * 60 + Number(catalogMatch.duration.match(/(\d+)\s*min/)?.[1] || 0) : Number(catalogMatch?.duration?.match(/(\d+)\s*min/)?.[1] || 0);
  if (catalogMatch && catalogMinutes) return { label: catalogMatch.name, durationMinutes: catalogMinutes };
  const isPedicure = value.includes('pedi');
  const isManicure = value.includes('mani');
  const duration = isPedicure ? 45 : isManicure ? 45 : 60;
  const label = isPedicure ? 'pedicure' : isManicure ? 'manicure' : service || 'nail appointment';
  return { label: gel ? `gel ${label}` : label, durationMinutes: duration + (gel ? 15 : 0) };
}

function localDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function toDateTime(date, hour, minute) {
  const [year, month, day] = date.split('-').map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(guess);
  const localGuess = Date.UTC(Number(parts.find(item => item.type === 'year').value), Number(parts.find(item => item.type === 'month').value) - 1, Number(parts.find(item => item.type === 'day').value), Number(parts.find(item => item.type === 'hour').value), Number(parts.find(item => item.type === 'minute').value));
  return new Date(guess.getTime() + (guess.getTime() - localGuess));
}

async function calendar() {
  const auth = await googleAuth();
  if (!auth) throw new Error('Google Calendar and Sheets are not connected yet.');
  return { auth, calendar: google.calendar({ version: 'v3', auth }), sheets: google.sheets({ version: 'v4', auth }) };
}

async function calendarBusy(start, end) {
  const { calendar: cal } = await calendar();
  const busy = await cal.freebusy.query({ requestBody: { timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: process.env.GOOGLE_CALENDAR_ID || 'primary' }] } });
  return busy.data.calendars?.[process.env.GOOGLE_CALENDAR_ID || 'primary']?.busy || [];
}

function businessWindow(day) {
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const hours = weeklyHours?.[weekday];
  if (Array.isArray(hours)) {
    const [startHour, startMinute] = String(hours[0]).split(':').map(Number);
    const [endHour, endMinute] = String(hours[1]).split(':').map(Number);
    return { start: toDateTime(day, startHour, startMinute), end: toDateTime(day, endHour, endMinute) };
  }
  if (!openDays.has(weekday)) return null;
  return { start: toDateTime(day, openTime[0], openTime[1]), end: toDateTime(day, closeTime[0], closeTime[1]) };
}

function bufferedBusy(events) {
  const buffer = bookingBufferMinutes * 60000;
  return events.map(event => ({ start: new Date(event.start).getTime() - buffer, end: new Date(event.end).getTime() + buffer }));
}

function salonTimeLabel(value) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

async function checkAvailability({ date, service, requestedTime = '', technician = '' }) {
  if (await squareConnected()) return squareAvailability({ date, service, requestedTime, technician });
  const detail = serviceDetails(service);
  const day = date || new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const window = businessWindow(day);
  if (!window) return { date: day, service: detail.label, durationMinutes: detail.durationMinutes, slots: [], reason: 'The salon is closed that day.' };
  const busy = bufferedBusy(await calendarBusy(window.start, window.end));
  const candidateSlots = [];
  const windowMinutes = (window.end.getTime() - window.start.getTime()) / 60000;
  for (let minutes = 0; minutes + detail.durationMinutes <= windowMinutes; minutes += 15) {
    const slotStart = new Date(window.start.getTime() + minutes * 60000);
    const slotEnd = new Date(slotStart.getTime() + detail.durationMinutes * 60000);
    const overlaps = busy.some(event => event.start < slotEnd.getTime() && event.end > slotStart.getTime());
    if (!overlaps) candidateSlots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString(), label: salonTimeLabel(slotStart), technician: technician || 'available team member' });
  }
  const requestedMinutes = /^\d{1,2}:\d{2}$/.test(requestedTime) ? requestedTime.split(':').map(Number).reduce((hour, minute) => hour * 60 + minute) : null;
  const hourSlots = candidateSlots.filter(slot => localDateParts(new Date(slot.start)).minute === '00');
  const offerableSlots = hourSlots.length ? hourSlots : candidateSlots;
  if (requestedMinutes !== null) offerableSlots.sort((a, b) => Math.abs(Number(localDateParts(new Date(a.start)).hour) * 60 + Number(localDateParts(new Date(a.start)).minute) - requestedMinutes) - Math.abs(Number(localDateParts(new Date(b.start)).hour) * 60 + Number(localDateParts(new Date(b.start)).minute) - requestedMinutes));
  const positions = requestedMinutes !== null
    ? offerableSlots.slice(0, 3).map((_, index) => index)
    : offerableSlots.length <= 3
    ? offerableSlots.map((_, index) => index)
    : [...new Set([0, Math.round((offerableSlots.length - 1) / 2), offerableSlots.length - 1])];
  return { date: day, service: detail.label, durationMinutes: detail.durationMinutes, slots: positions.map(index => offerableSlots[index]) };
}

async function slotIsAvailable(startValue, endValue) {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return false;
  const busy = bufferedBusy(await calendarBusy(new Date(start.getTime() - bookingBufferMinutes * 60000), new Date(end.getTime() + bookingBufferMinutes * 60000)));
  return !busy.some(event => event.start < end.getTime() && event.end > start.getTime());
}

async function squareSlotIsAvailable(booking, checkedSlots) {
  const returned = checkedSlots.find(slot => new Date(slot.start).getTime() === new Date(booking.start).getTime() && new Date(slot.end).getTime() === new Date(booking.end).getTime());
  if (!returned) return null;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(booking.start));
  const latest = await squareAvailability({ date: day, service: booking.service, requestedTime: '', technician: booking.technician || '' });
  return latest.slots.find(slot => new Date(slot.start).getTime() === new Date(booking.start).getTime() && new Date(slot.end).getTime() === new Date(booking.end).getTime()) || null;
}

async function calendarEvents(date) {
  if (await squareConnected()) {
    const profile = await squareProfile();
    const day = date || new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
    const start = toDateTime(day, 0, 0).toISOString();
    const end = toDateTime(day, 23, 59).toISOString();
    const payload = await squareRequest(`/bookings?location_id=${encodeURIComponent(profile.locationId)}&start_at_min=${encodeURIComponent(start)}&start_at_max=${encodeURIComponent(end)}`);
    return { date: day, events: (payload.bookings || []).map(booking => ({ id: booking.id, summary: booking.appointment_segments?.[0]?.service_variation_id ? `Square appointment · ${booking.status || 'booked'}` : 'Square appointment', description: booking.customer_note || 'Managed by Square Appointments', start: booking.start_at, end: new Date(new Date(booking.start_at).getTime() + Number(booking.appointment_segments?.[0]?.duration_minutes || 60) * 60000).toISOString(), status: booking.status })) };
  }
  const { calendar: cal } = await calendar();
  const day = date || new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const start = toDateTime(day, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60000);
  const response = await cal.events.list({ calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary', timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 100 });
  return { date: day, events: (response.data.items || []).map(event => ({ id: event.id, summary: event.summary || 'Busy', description: event.description || '', start: event.start?.dateTime || event.start?.date, end: event.end?.dateTime || event.end?.date, status: event.status })) };
}

async function blockCalendarTime({ start, end, summary = 'Blocked time', notes = '' }) {
  if (!start || !end || new Date(end) <= new Date(start)) throw new Error('Choose a valid start and end time.');
  const { calendar: cal } = await calendar();
  const event = await cal.events.insert({ calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary', requestBody: { summary, description: notes, start: { dateTime: start, timeZone: timezone }, end: { dateTime: end, timeZone: timezone } } });
  await appendLog({ type: 'blocked_time', start, end, summary, notes, calendarEventId: event.data.id });
  return { id: event.data.id, summary, notes, start, end };
}

async function readSheetInfo() {
  try {
    const { spreadsheetId } = JSON.parse(await fs.readFile(path.join(dataDir, 'sheet.json'), 'utf8'));
    return spreadsheetId ? { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` } : null;
  } catch { return null; }
}

async function completeBooking(booking, checkedSlots = []) {
  if (!String(booking.customerName || '').trim() || /^(customer|unknown|caller|guest|the customer)$/i.test(String(booking.customerName).trim())) throw new Error('I need the customer name before I can complete the booking.');
  if (await squareConnected()) {
    const slot = await squareSlotIsAvailable(booking, checkedSlots);
    if (!slot) throw new Error('That opening was just taken. I will check the next closest time.');
    const square = await squareBooking({ ...booking, ...slot });
    const bookingId = square.booking?.id || '';
    const confirmation = `You’re booked at ${salonName} for ${booking.service} on ${new Date(booking.start).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' })}. See you soon!\n\nAddress: ${salonAddress}`;
    const [smsResult, ownerResult] = await Promise.allSettled([
      sendText(booking.phone, confirmation),
      process.env.SALON_OWNER_PHONE ? sendText(process.env.SALON_OWNER_PHONE, `Mika booked ${booking.customerName} for ${booking.service} on ${new Date(booking.start).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' })}.`) : Promise.resolve({ sent: false, skipped: true })
    ]);
    const sms = smsResult.status === 'fulfilled' ? smsResult.value : { sent: false, error: smsResult.reason?.message || 'SMS failed' };
    const owner = ownerResult.status === 'fulfilled' ? ownerResult.value : { sent: false };
    return { ...booking, eventId: bookingId, squareBookingId: bookingId, calendarBooked: true, sheetUrl: '', sheetStatus: 'not_required', confirmationSent: sms.sent, smsStatus: sms.sent ? 'sent' : 'failed', smsError: sms.error || '', ownerStatus: owner.sent ? 'sent' : 'skipped', source: 'square' };
  }
  const { calendar: cal, sheets } = await calendar();
  const chosenStart = new Date(booking.start).getTime();
  const chosenEnd = new Date(booking.end).getTime();
  const bookingDay = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(booking.start));
  const window = businessWindow(bookingDay);
  if (!window || chosenStart < window.start.getTime() || chosenEnd > window.end.getTime()) throw new Error('That time is outside the salon hours. I will check another opening.');
  const wasReturned = checkedSlots.some(slot => new Date(slot.start).getTime() === chosenStart && new Date(slot.end).getTime() === chosenEnd);
  if (!wasReturned) throw new Error('I can only book an opening I just checked. Let me check the calendar again.');
  if (!(await slotIsAvailable(booking.start, booking.end))) throw new Error('That opening was just taken. I will check the next closest time.');
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const event = await cal.events.insert({ calendarId, requestBody: {
    summary: `${booking.customerName} · ${booking.service}`,
    description: `Booked by Mika AI receptionist. Customer phone: ${booking.phone}. Technician: ${booking.technician || 'available team member'}. Notes: ${booking.notes || 'None'}`,
    start: { dateTime: booking.start, timeZone: timezone },
    end: { dateTime: booking.end, timeZone: timezone }
  } });
  const confirmation = `You’re booked at ${salonName} for ${booking.service} on ${new Date(booking.start).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' })}. See you soon!\n\nAddress: ${salonAddress}`;
  const [sheetResult, smsResult, ownerResult] = await Promise.allSettled([
    (async () => { const sheetId = await ensureBookingSheet(sheets); await sheets.spreadsheets.values.append({ spreadsheetId: sheetId, range: 'Bookings!A:H', valueInputOption: 'USER_ENTERED', requestBody: { values: [[new Date().toISOString(), booking.customerName, booking.phone, booking.service, booking.technician || 'available team member', booking.start, event.data.id, booking.notes || '']] } }); return { sheetId, sheetUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit` }; })(),
    sendText(booking.phone, confirmation),
    process.env.SALON_OWNER_PHONE ? sendText(process.env.SALON_OWNER_PHONE, `Mika booked ${booking.customerName} for ${booking.service} on ${new Date(booking.start).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' })}.`) : Promise.resolve({ sent: false, skipped: true })
  ]);
  const sheet = sheetResult.status === 'fulfilled' ? sheetResult.value : { sheetError: sheetResult.reason?.message || 'Sheet write failed' };
  const sms = smsResult.status === 'fulfilled' ? smsResult.value : { sent: false, error: smsResult.reason?.message || 'SMS failed' };
  const owner = ownerResult.status === 'fulfilled' ? ownerResult.value : { sent: false, error: ownerResult.reason?.message || 'Owner notification failed' };
  return { ...booking, eventId: event.data.id, calendarBooked: true, sheetUrl: sheet.sheetUrl || '', sheetStatus: sheet.sheetUrl ? 'saved' : 'failed', sheetError: sheet.sheetError || '', confirmationSent: sms.sent, smsStatus: sms.sent ? 'sent' : 'failed', smsError: sms.error || '', ownerStatus: owner.sent ? 'sent' : 'skipped' };
}

async function ensureBookingSheet(sheets) {
  const sheetIdFile = path.join(dataDir, 'sheet.json');
  let sheetId;
  try { sheetId = JSON.parse(await fs.readFile(sheetIdFile, 'utf8')).spreadsheetId; } catch {}
  if (!sheetId) {
    const created = await sheets.spreadsheets.create({ requestBody: { properties: { title: `${salonName} · Mika bookings` }, sheets: [{ properties: { title: 'Bookings' } }] } });
    sheetId = created.data.spreadsheetId;
    await fs.writeFile(sheetIdFile, JSON.stringify({ spreadsheetId: sheetId }));
    await sheets.spreadsheets.values.update({ spreadsheetId: sheetId, range: 'Bookings!A1:H1', valueInputOption: 'RAW', requestBody: { values: [['Created', 'Customer', 'Phone', 'Service', 'Technician', 'Start', 'Calendar event', 'Notes']] } });
  }
  return sheetId;
}

async function syncCalendarBookingsToSheet(sheets, spreadsheetId) {
  const now = Date.now();
  const { calendar: cal } = await calendar();
  const events = await cal.events.list({ calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary', timeMin: new Date(now - 90 * 86400000).toISOString(), timeMax: new Date(now + 365 * 86400000).toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 2500 });
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'Bookings!A:H' });
  const rows = existing.data.values || [];
  const existingEventIds = new Set(rows.slice(1).map(row => row[6]).filter(Boolean));
  const missing = (events.data.items || []).filter(event => event.status !== 'cancelled' && String(event.description || '').includes('Booked by Mika AI receptionist') && !existingEventIds.has(event.id));
  if (!missing.length) return 0;
  const values = missing.map(event => {
    const description = String(event.description || '');
    const summary = String(event.summary || '');
    const separator = summary.indexOf(' · ');
    const customer = separator >= 0 ? summary.slice(0, separator) : summary;
    const service = separator >= 0 ? summary.slice(separator + 3) : '';
    const phone = description.match(/Customer phone:\s*([^\.]+)/i)?.[1]?.trim() || '';
    const technician = description.match(/Technician:\s*([^\.]+)/i)?.[1]?.trim() || 'available team member';
    const notes = description.match(/Notes:\s*([^\.]+)$/i)?.[1]?.trim() || '';
    return [event.created || new Date().toISOString(), customer, phone, service, technician, event.start?.dateTime || event.start?.date || '', event.id, notes];
  });
  await sheets.spreadsheets.values.update({ spreadsheetId, range: 'Bookings!A1:H1', valueInputOption: 'RAW', requestBody: { values: [['Created', 'Customer', 'Phone', 'Service', 'Technician', 'Start', 'Calendar event', 'Notes']] } });
  await sheets.spreadsheets.values.append({ spreadsheetId, range: 'Bookings!A:H', valueInputOption: 'USER_ENTERED', requestBody: { values } });
  return values.length;
}

async function sendText(to, body) {
  if (!twilioClient || !to || !process.env.TWILIO_PHONE_NUMBER) return { sent: false };
  try {
    const message = await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body });
    return { sent: true, sid: message.sid };
  } catch (error) {
    return { sent: false, errorCode: error.code || 'twilio_error', error: error.message };
  }
}

const receptionistPrompt = async () => {
  const profile = await activeSalonProfile();
  const profileName = profile.name || salonName;
  const profileAddress = profile.address || salonAddress;
  const catalog = (profile.services || []).map(item => typeof item === 'string' ? item : `${item.name}${item.duration ? ` (${item.duration})` : ''}${item.price ? ` ${item.price}` : ''}`).join(', ');
  const profileContext = profile.website ? `\n\nSalon profile source: ${profile.website}\nSalon profile name: ${profileName}\nSalon profile description: ${profile.description || 'No description imported.'}\nSalon address: ${profileAddress}\nSalon phone: ${profile.phone || 'Not imported.'}\nSalon hours: ${profile.hours || 'Not imported.'}\nSalon services: ${catalog || 'Not imported.'}` : '';
  const sourceContext = `\n\nScheduling source of truth: ${await squareConnected() ? 'Square Appointments. Availability and booking state must come from Square tool results.' : 'legacy Google Calendar until Square is connected.'}`;
  return promptTemplate.replaceAll('{{SALON_NAME}}', profileName).replaceAll('{{SALON_TIMEZONE}}', timezone) + profileContext + sourceContext;
};

function toolDefinitions() {
  return [
    { type: 'function', name: 'check_availability', description: 'The only way to know appointment availability. Query the connected Square Appointments account and return only Square slots. Never invent a slot or default to a time.', parameters: { type: 'object', properties: { date: { type: 'string', description: 'Requested date in YYYY-MM-DD.' }, service: { type: 'string' }, requestedTime: { type: 'string', description: 'Optional requested local time in HH:MM.' }, technician: { type: 'string' } }, required: ['date', 'service'] } },
    { type: 'function', name: 'complete_booking', description: 'Only call after the customer chooses one exact slot returned by the latest check_availability result and gives a real name. Ask the caller what name to put the appointment under. Never use Customer, Unknown, Caller, Guest, or a made-up name. The server rejects any other time or placeholder name. Recheck it, create the booking in Square, record the outcome, and send the Twilio SMS confirmation. The caller phone comes from Twilio automatically.', parameters: { type: 'object', properties: { customerName: { type: 'string', description: 'The real customer name spoken by the caller. Never use a placeholder.' }, phone: { type: 'string' }, service: { type: 'string' }, technician: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, notes: { type: 'string' } }, required: ['customerName', 'service', 'start', 'end'] } }
  ];
}

async function handleTool(name, args, context = {}) {
  if (name === 'check_availability') {
    const output = await checkAvailability(args);
    context.lastAvailabilitySlots = output.slots || [];
    await appendLog({ type: 'tool_check_availability', callSid: context.callSid, phone: context.phone, details: JSON.stringify({ args, output }) });
    return output;
  }
  if (name === 'complete_booking') {
    const booking = await completeBooking(args, context.lastAvailabilitySlots || []);
    context.lastAvailabilitySlots = [];
    await appendLog({ type: 'booking', callSid: context.callSid, customer: args.customerName, phone: args.phone, service: args.service, start: args.start, technician: args.technician || 'available team member', notes: args.notes || '', calendarEventId: booking.eventId, sheetStatus: booking.sheetStatus, sheetError: booking.sheetError, smsStatus: booking.smsStatus, smsError: booking.smsError });
    return booking;
  }
  return { error: 'Unknown tool.' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/status') {
      const profile = await activeSalonProfile();
      const googleConnected = Boolean(await readToken());
      const squareIsConnected = await squareConnected();
      let square = null;
      if (squareIsConnected) {
        try { const squareSalon = await squareProfile(); square = { connected: true, locationId: squareSalon.locationId, name: squareSalon.name, address: squareSalon.address, services: await squareServices() }; }
        catch (error) { square = { connected: true, error: error.message }; }
      }
      let sheet = await readSheetInfo();
      let sheetError = '';
      if (googleConnected && !sheet) {
        try { const { sheets } = await calendar(); const spreadsheetId = await ensureBookingSheet(sheets); sheet = { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` }; }
        catch (error) { sheetError = error.message; console.error(`Booking sheet: ${error.message}`); }
      }
      return json(res, 200, { salonName: square?.name || profile.name || salonName, address: square?.address || profile.address || salonAddress, phone: process.env.TWILIO_PHONE_NUMBER || '', schedulingSource: squareIsConnected ? 'Square Appointments' : 'Google Calendar (legacy)', square, googleConnected, sheet, sheetError, profile });
    }
    if (url.pathname === '/api/logs') return json(res, 200, await readLogs());
    if (url.pathname === '/api/calendar/events') return json(res, 200, await calendarEvents(url.searchParams.get('date')));
    if (url.pathname === '/api/calendar/block' && req.method === 'POST') return json(res, 200, await blockCalendarTime(await readBody(req)));
    if (url.pathname === '/api/sheet/rows') {
      const info = await readSheetInfo();
      if (!info) return json(res, 404, { error: 'The booking Sheet is not available yet.' });
      const { sheets } = await calendar();
      await syncCalendarBookingsToSheet(sheets, info.spreadsheetId);
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: info.spreadsheetId, range: 'Bookings!A:H' });
      return json(res, 200, { ...info, rows: response.data.values || [] });
    }
    if (url.pathname === '/api/google/connect') {
      const auth = oauthClient(requestRedirectUri(req));
      const consentUrl = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/spreadsheets'] });
      res.writeHead(302, { location: consentUrl }); return res.end();
    }
    if (url.pathname === '/api/square/connect') {
      if (!process.env.SQUARE_APPLICATION_ID) return json(res, 503, { error: 'Square is not configured yet. Add SQUARE_APPLICATION_ID and SQUARE_APPLICATION_SECRET in Render.' });
      const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await fs.writeFile(path.join(dataDir, 'square-oauth-state'), state);
      const params = new URLSearchParams({ client_id: process.env.SQUARE_APPLICATION_ID, scope: 'APPOINTMENTS_ALL_READ APPOINTMENTS_ALL_WRITE CUSTOMERS_READ CUSTOMERS_WRITE MERCHANT_PROFILE_READ', session: squareEnvironment === 'production' ? 'false' : 'true', state, redirect_uri: squareRedirectUri(req) });
      res.writeHead(302, { location: `${squareOauthBase}/authorize?${params}` }); return res.end();
    }
    if (url.pathname === '/api/square/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      let expectedState = '';
      try { expectedState = await fs.readFile(path.join(dataDir, 'square-oauth-state'), 'utf8'); } catch {}
      if (!code || !state || state !== expectedState) return json(res, 400, { error: 'Invalid Square authorization response.' });
      const tokens = await squareOAuthToken({ code, grant_type: 'authorization_code', redirect_uri: squareRedirectUri(req) });
      await fs.writeFile(path.join(dataDir, 'square-token.json'), JSON.stringify(tokens));
      await fs.rm(path.join(dataDir, 'square-oauth-state'), { force: true });
      res.writeHead(302, { location: '/dashboard.html?square=connected' }); return res.end();
    }
    if (url.pathname === '/api/google/callback') {
      const code = url.searchParams.get('code');
      if (!code) return json(res, 400, { error: 'Start Google connection at /api/google/connect. This callback page cannot be opened directly.' });
      const auth = oauthClient(requestRedirectUri(req));
      const { tokens } = await auth.getToken(code);
      await fs.writeFile(path.join(dataDir, 'google-token.json'), JSON.stringify(tokens));
      auth.setCredentials(tokens);
      await ensureBookingSheet(google.sheets({ version: 'v4', auth }));
      res.writeHead(302, { location: '/dashboard.html?google=connected' }); return res.end();
    }
    if (url.pathname === '/twilio/voice') {
      const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};
      const twiml = new twilio.twiml.VoiceResponse();
      const connect = twiml.connect();
      const streamBase = requestPublicBaseUrl(req).replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
      const stream = connect.stream({ url: `${streamBase}/twilio/media` });
      if (body.From) stream.parameter({ name: 'callerPhone', value: body.From });
      res.writeHead(200, { 'content-type': 'text/xml' }); return res.end(twiml.toString());
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const content = await fs.readFile(path.join(publicDir, file));
    const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
    res.writeHead(200, { 'content-type': type }); res.end(content); return;
  } catch (error) {
    console.error(error.message);
    json(res, 500, { error: error.message });
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, `http://${req.headers.host}`).pathname !== '/twilio/media') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (twilioWs) => {
  let streamSid;
  let openaiWs;
  let callerPhone = '';
  const callContext = { callSid: null, phone: '', lastAvailabilitySlots: [] };
  const connectOpenAI = () => {
    openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini'}`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
    openaiWs.on('open', async () => {
      openaiWs.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: await receptionistPrompt(), output_modalities: ['audio'], audio: { input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 400, silence_duration_ms: 1200, create_response: false, interrupt_response: true } }, output: { format: { type: 'audio/pcmu' }, voice: 'marin' } }, tools: toolDefinitions(), tool_choice: 'auto' } }));
      openaiWs.send(JSON.stringify({ type: 'response.create', response: { instructions: `Say exactly: Hi, this is ${salonName}. How can I help you?` } }));
    });
    openaiWs.on('message', async (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'response.output_audio.delta' && streamSid) twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
      if (event.type === 'input_audio_buffer.speech_stopped') openaiWs.send(JSON.stringify({ type: 'response.create' }));
      if (event.type === 'response.function_call_arguments.done') {
        try {
          const args = JSON.parse(event.arguments);
          const output = await handleTool(event.name, { ...args, phone: args.phone || callerPhone }, callContext);
          openaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(output) } }));
          const strictInstructions = event.name === 'check_availability'
            ? output.slots?.length
              ? (() => {
                const requestedMatch = String(args.requestedTime || '').match(/^(\d{1,2}):\d{2}$/);
                const requestedHour = requestedMatch ? Number(requestedMatch[1]) : null;
                if (requestedHour === null) return `The caller did not give a specific time. Offer no more than two or three of these exact returned openings in salon local time: ${output.slots.slice(0, 3).map(slot => slot.label).join(', ')}. Say: “Here’s what I’m seeing: ${output.slots.slice(0, 3).map(slot => slot.label).join(', ')}. Which works best?” Do not say any other time.`;
                const exactSlot = requestedHour === null ? null : output.slots.find(slot => {
                  const hour = Number(localDateParts(new Date(slot.start)).hour);
                  return hour === requestedHour || hour === (requestedHour + 12) % 24;
                });
                if (exactSlot) return `The caller already gave the time. The exact requested opening is available at ${exactSlot.label}. Do not ask what time they want again and do not list other openings. Say briefly: “I have ${exactSlot.label} available.” Then continue with only the next missing booking detail.`;
                const alternatives = output.slots.slice(0, 2).map(slot => slot.label).join(' or ');
                return `The caller already gave the time, but it is not among the returned openings. Say “I don’t have an opening around that time, but I do have ${alternatives}.” Do not call the requested time booked, do not ask the time again, and do not offer any other time.`;
              })()
              : 'The availability check returned no openings. Say that no opening was found for that day and ask whether the caller wants another day. Do not suggest any time.'
            : event.name === 'complete_booking'
              ? output.confirmationSent ? `The booking succeeded and the confirmation was sent. Use the customer’s name in the goodbye. Say exactly: “You’re all set, ${output.customerName || args.customerName}. Thank you. Your nails have a date. I’ve sent your confirmation.”` : 'The booking succeeded but the confirmation message did not send. Be honest about that.'
              : '';
          openaiWs.send(JSON.stringify({ type: 'response.create', response: strictInstructions ? { instructions: strictInstructions } : undefined }));
        }
        catch (error) { await appendLog({ type: 'tool_error', callSid: callContext.callSid, phone: callerPhone, details: JSON.stringify({ tool: event.name, arguments: event.arguments, error: error.message }) }); openaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify({ error: error.message }) } })); const recovery = /customer name/i.test(error.message) ? 'Stop the booking flow and ask exactly: What’s your name? Do not book, confirm, or invent a name until the caller answers.' : /opening.*checked|just taken/i.test(error.message) ? 'Do not confirm the booking. Say the opening changed and check availability again.' : ''; openaiWs.send(JSON.stringify({ type: 'response.create', response: recovery ? { instructions: recovery } : undefined })); }
      }
    });
  };
  twilioWs.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.event === 'start') { streamSid = event.start.streamSid; callerPhone = event.start.customParameters?.callerPhone || ''; callContext.callSid = event.start.callSid || null; callContext.phone = callerPhone; appendLog({ type: 'call_started', callSid: callContext.callSid, phone: callerPhone }); connectOpenAI(); } if (event.event === 'media' && openaiWs?.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: event.media.payload })); });
  twilioWs.on('close', () => openaiWs?.close());
});

server.listen(port, host, () => console.log(`Mika is ready at http://${host}:${port}`));
