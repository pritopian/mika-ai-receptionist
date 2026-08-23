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
const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

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

const defaultPauaProfile = { website: 'https://pauabeautylounge.booksy.com/', name: 'Paua Beauty Lounge', title: 'Paua Beauty Lounge', description: 'Nail salon appointments handled by Mika.', address: '1455 Powell St, San Francisco, CA 94133', phone: '(415) 525-4766', hours: '', services: pauaServices, status: 'confirmed' };

const isPauaBooksyPage = website => /(?:pauabeautylounge|paua-beauty-lounge|387858)/i.test(website || '');

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
  entries.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), ...entry });
  await fs.writeFile(logFile, JSON.stringify(entries.slice(0, 200), null, 2));
}

async function readLogs() {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, 'activity.json'), 'utf8')); } catch { return []; }
}

async function readProfile() {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, 'salon-profile.json'), 'utf8')); } catch { return {}; }
}

function decodeHtml(value = '') {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function plainText(value = '') {
  return decodeHtml(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function structuredBusinessData(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      const candidates = Array.isArray(parsed) ? parsed : [parsed, ...(parsed?.['@graph'] || [])];
      const business = candidates.find(item => /LocalBusiness|BeautySalon|HairSalon|NailSalon|DaySpa|HealthAndBeautyBusiness/i.test(String(item?.['@type'] || '')));
      if (business) return business;
    } catch {}
  }
  return {};
}

function extractSalonProfile(html, website) {
  const business = structuredBusinessData(html);
  const address = business.address && typeof business.address === 'object'
    ? [business.address.streetAddress, business.address.addressLocality, business.address.addressRegion, business.address.postalCode].filter(Boolean).join(', ')
    : String(business.address || '');
  let services = (Array.isArray(business.makesOffer) ? business.makesOffer : Array.isArray(business.hasOfferCatalog?.itemListElement) ? business.hasOfferCatalog.itemListElement : [])
    .map(item => item?.itemOffered?.name || item?.name || item?.item?.name)
    .filter(Boolean)
    .slice(0, 12);
  const hours = Array.isArray(business.openingHoursSpecification)
    ? business.openingHoursSpecification.map(item => `${(Array.isArray(item.dayOfWeek) ? item.dayOfWeek : [item.dayOfWeek]).filter(Boolean).join(', ')} ${item.opens || ''}-${item.closes || ''}`.trim()).join('; ')
    : Array.isArray(business.openingHours) ? business.openingHours.join('; ') : String(business.openingHours || '');
  const title = plainText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
  const description = decodeHtml(html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1]?.trim() || '');
  const phone = business.telephone || html.match(/(?:tel:|phone[^>]*>)([^<]+)/i)?.[1]?.trim() || '';
  if (isPauaBooksyPage(website)) services = pauaServices;
  return { website, name: isPauaBooksyPage(website) ? 'Paua Beauty Lounge' : business.name || title.split('|')[0].split('-')[0].trim() || salonName, title, description, address: address || (isPauaBooksyPage(website) ? '1455 Powell St, San Francisco, CA 94133' : ''), phone: phone || (isPauaBooksyPage(website) ? '(415) 525-4766' : ''), hours, services, status: 'needs_review', importedAt: new Date().toISOString() };
}

async function activeSalonProfile() {
  const profile = await readProfile();
  if (/paua/i.test(salonName)) {
    const activePaua = { ...defaultPauaProfile, ...profile, services: profile.services?.length ? profile.services : pauaServices, address: profile.address || defaultPauaProfile.address, phone: profile.phone || defaultPauaProfile.phone };
    globalThis.__mikaProfile = activePaua;
    return activePaua;
  }
  const active = profile.status === 'confirmed' ? profile : { ...profile, name: profile.name || salonName, address: profile.address || salonAddress };
  globalThis.__mikaProfile = active;
  return active;
}

function ownerCookie(email) {
  return Buffer.from(JSON.stringify({ email, at: Date.now() })).toString('base64url');
}

async function logActivityToSheet(entry) {
  try {
    const { sheets } = await calendar();
    const { spreadsheetId } = JSON.parse(await fs.readFile(path.join(dataDir, 'sheet.json'), 'utf8'));
    try { await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: 'Activity' } } }] } }); } catch {}
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

const oauthClient = (redirectUri = process.env.GOOGLE_REDIRECT_URI) => new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  redirectUri
);

async function readToken() {
  try { return JSON.parse(await fs.readFile(path.join(dataDir, 'google-token.json'), 'utf8')); }
  catch { return process.env.GOOGLE_REFRESH_TOKEN ? { refresh_token: process.env.GOOGLE_REFRESH_TOKEN } : null; }
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
  return new Date(Date.UTC(year, month - 1, day, hour + 7, minute));
}

async function calendar() {
  const auth = await googleAuth();
  if (!auth) throw new Error('Google Calendar and Sheets are not connected yet.');
  return { auth, calendar: google.calendar({ version: 'v3', auth }), sheets: google.sheets({ version: 'v4', auth }) };
}

async function checkAvailability({ date, service, gel = false, technician = '' }) {
  const { calendar: cal } = await calendar();
  const detail = serviceDetails(service, gel);
  const day = date || new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
  const start = toDateTime(day, 10, 0);
  const end = toDateTime(day, 19, 0);
  const busy = await cal.freebusy.query({ requestBody: { timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: process.env.GOOGLE_CALENDAR_ID || 'primary' }] } });
  const events = busy.data.calendars?.[process.env.GOOGLE_CALENDAR_ID || 'primary']?.busy || [];
  const candidateSlots = [];
  for (let minutes = 0; minutes + detail.durationMinutes <= 540; minutes += 15) {
    const slotStart = new Date(start.getTime() + minutes * 60000);
    const slotEnd = new Date(slotStart.getTime() + detail.durationMinutes * 60000);
    const overlaps = events.some((event) => new Date(event.start) < slotEnd && new Date(event.end) > slotStart);
    if (!overlaps) candidateSlots.push({ start: slotStart.toISOString(), end: slotEnd.toISOString(), technician: technician || 'available team member' });
  }
  const positions = candidateSlots.length <= 3
    ? candidateSlots.map((_, index) => index)
    : [...new Set([0, Math.round((candidateSlots.length - 1) / 2), candidateSlots.length - 1])];
  return { date: day, service: detail.label, durationMinutes: detail.durationMinutes, slots: positions.map(index => candidateSlots[index]) };
}

async function calendarEvents(date) {
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

async function logBooking(booking) {
  const { calendar: cal, sheets } = await calendar();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
  const event = await cal.events.insert({ calendarId, requestBody: {
    summary: `${booking.customerName} · ${booking.service}`,
    description: `Booked by Mika AI receptionist. Customer phone: ${booking.phone}. Technician: ${booking.technician || 'available team member'}. Notes: ${booking.notes || 'None'}`,
    start: { dateTime: booking.start, timeZone: timezone },
    end: { dateTime: booking.end, timeZone: timezone }
  } });
  let sheetId;
  let sheetError = '';
  try {
    sheetId = await ensureBookingSheet(sheets);
    await sheets.spreadsheets.values.append({ spreadsheetId: sheetId, range: 'Bookings!A:H', valueInputOption: 'USER_ENTERED', requestBody: { values: [[new Date().toISOString(), booking.customerName, booking.phone, booking.service, booking.technician || 'available team member', booking.start, event.data.id, booking.notes || '']] } });
  } catch (error) {
    sheetError = error.message;
    console.error(`Booking log: ${sheetError}`);
  }
  return { ...booking, eventId: event.data.id, sheetId, sheetError, sheetUrl: sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit` : '' };
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

async function sendText(to, body) {
  if (!twilioClient || !to || !process.env.TWILIO_PHONE_NUMBER) return { sent: false };
  try {
    const message = await twilioClient.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body });
    return { sent: true, sid: message.sid };
  } catch (error) {
    return { sent: false, errorCode: error.code || 'twilio_error', error: error.message };
  }
}

async function sendEmail(to, subject, body) {
  if (!process.env.RESEND_API_KEY || !process.env.SALON_FROM_EMAIL || !to) return { sent: false, skipped: true };
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.SALON_FROM_EMAIL, to: [to], subject, text: body }) });
  if (!response.ok) return { sent: false, error: await response.text() };
  return { sent: true, provider: 'resend' };
}

const receptionistPrompt = async () => {
  const profile = await activeSalonProfile();
  const profileName = profile.name || salonName;
  const profileAddress = profile.address || salonAddress;
  const catalog = (profile.services || []).map(item => typeof item === 'string' ? item : `${item.name}${item.duration ? ` (${item.duration})` : ''}${item.price ? ` ${item.price}` : ''}`).join(', ');
  const profileContext = profile.website ? `\n\nSalon profile source: ${profile.website}\nSalon profile name: ${profileName}\nSalon profile description: ${profile.description || 'No description imported.'}\nSalon address: ${profileAddress}\nSalon phone: ${profile.phone || 'Not imported.'}\nSalon hours: ${profile.hours || 'Not imported.'}\nSalon services: ${catalog || 'Not imported.'}` : '';
  return promptTemplate.replaceAll('{{SALON_NAME}}', profileName).replaceAll('{{SALON_TIMEZONE}}', timezone) + profileContext;
};

function toolDefinitions() {
  return [
    { type: 'function', name: 'check_availability', description: 'Look up open appointment slots in the salon Google Calendar. Return real openings spread across the day when possible.', parameters: { type: 'object', properties: { date: { type: 'string', description: 'Requested date in YYYY-MM-DD.' }, service: { type: 'string' }, technician: { type: 'string' } }, required: ['date', 'service'] } },
    { type: 'function', name: 'book_appointment', description: 'Create the confirmed appointment in Google Calendar and the booking log in Google Sheets. The caller phone comes from Twilio automatically.', parameters: { type: 'object', properties: { customerName: { type: 'string' }, phone: { type: 'string' }, service: { type: 'string' }, technician: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, notes: { type: 'string' } }, required: ['customerName', 'service', 'start', 'end'] } }
  ];
}

async function handleTool(name, args) {
  if (name === 'check_availability') return checkAvailability(args);
  if (name === 'book_appointment') {
    const booking = await logBooking(args);
    const confirmation = `You’re booked at ${salonName} for ${args.service} on ${new Date(args.start).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' })}. See you soon!\n\nAddress: ${salonAddress}`;
    const customerText = await sendText(args.phone, confirmation);
    const customerEmail = await sendEmail(args.email, `Your ${salonName} appointment`, confirmation);
    const ownerText = await sendText(process.env.SALON_OWNER_PHONE, `Mika booked ${args.customerName} for ${args.service} on ${new Date(args.start).toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' })}. Technician: ${args.technician || 'available team member'}.`);
    await appendLog({ type: 'booking', customer: args.customerName, phone: args.phone, service: args.service, start: args.start, technician: args.technician || 'available team member', notes: args.notes || '', calendarEventId: booking.eventId, sheetStatus: booking.sheetError ? 'failed' : 'saved', sheetError: booking.sheetError || '', notifications: { customerText, customerEmail, ownerText } });
    await logActivityToSheet({ type: 'booking', customer: args.customerName, service: args.service, status: 'booked', channel: 'calendar', details: booking.eventId });
    await logActivityToSheet({ type: 'customer confirmation', customer: args.customerName, service: args.service, status: customerText.sent ? 'sent' : 'blocked', channel: 'sms', details: customerText.errorCode || '' });
    await logActivityToSheet({ type: 'customer confirmation', customer: args.customerName, service: args.service, status: customerEmail.sent ? 'sent' : 'not configured', channel: 'email', details: customerEmail.error || '' });
    await logActivityToSheet({ type: 'owner notification', customer: args.customerName, service: args.service, status: ownerText.sent ? 'sent' : 'blocked', channel: 'sms', details: ownerText.errorCode || '' });
    return { ...booking, calendarBooked: true, confirmationSent: customerText.sent || customerEmail.sent, sheetUrl: booking.sheetUrl };
  }
  return { error: 'Unknown tool.' };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/status') {
      const profile = await activeSalonProfile();
      const googleConnected = Boolean(await readToken());
      let sheet = await readSheetInfo();
      let sheetError = '';
      if (googleConnected && !sheet) {
        try { const { sheets } = await calendar(); const spreadsheetId = await ensureBookingSheet(sheets); sheet = { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit` }; }
        catch (error) { sheetError = error.message; console.error(`Booking sheet: ${error.message}`); }
      }
      return json(res, 200, { salonName: profile.name || salonName, address: profile.address || salonAddress, phone: process.env.TWILIO_PHONE_NUMBER || '', googleConnected, sheet, sheetError, profile });
    }
    if (url.pathname === '/api/logs') return json(res, 200, await readLogs());
    if (url.pathname === '/api/calendar/events') return json(res, 200, await calendarEvents(url.searchParams.get('date')));
    if (url.pathname === '/api/calendar/block' && req.method === 'POST') return json(res, 200, await blockCalendarTime(await readBody(req)));
    if (url.pathname === '/api/sheet/rows') {
      const info = await readSheetInfo();
      if (!info) return json(res, 404, { error: 'The booking Sheet is not available yet.' });
      const { sheets } = await calendar();
      const response = await sheets.spreadsheets.values.get({ spreadsheetId: info.spreadsheetId, range: 'Bookings!A:G' });
      return json(res, 200, { ...info, rows: response.data.values || [] });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const { email } = await readBody(req);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) return json(res, 400, { error: 'Enter a valid email address.' });
      await fs.writeFile(path.join(dataDir, 'owner.json'), JSON.stringify({ email, signedInAt: new Date().toISOString() }, null, 2));
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `mika_owner=${ownerCookie(email)}; Path=/; SameSite=Lax` }); return res.end(JSON.stringify({ ok: true, email }));
    }
    if (url.pathname === '/api/profile/import' && req.method === 'POST') {
      const { website } = await readBody(req);
      if (!/^https?:\/\//i.test(String(website || ''))) return json(res, 400, { error: 'Paste a full website URL.' });
      let title = '';
      let description = '';
      let html = '';
      try {
        const response = await fetch(website, { headers: { 'user-agent': 'Mika salon profile importer' } });
        html = await response.text();
        title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() || '';
        description = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1]?.trim() || '';
      } catch (error) { return json(res, 400, { error: `Could not read that website: ${error.message}` }); }
      const profile = extractSalonProfile(html, website);
      await fs.writeFile(path.join(dataDir, 'salon-profile.json'), JSON.stringify(profile, null, 2));
      return json(res, 200, { ok: true, profile });
    }
    if (url.pathname === '/api/profile/confirm' && req.method === 'POST') {
      const current = await readProfile();
      const body = await readBody(req);
      const services = Array.isArray(body.services) ? body.services.map(item => typeof item === 'object' ? { category: String(item.category || '').trim(), name: String(item.name || '').trim(), price: String(item.price || '').trim(), duration: String(item.duration || '').trim(), description: String(item.description || '').trim() } : { category: '', name: String(item).trim(), price: '', duration: '', description: '' }).filter(item => item.name) : current.services || [];
      const profile = { ...current, name: String(body.name || '').trim(), address: String(body.address || '').trim(), phone: String(body.phone || '').trim(), hours: String(body.hours || '').trim(), services, status: 'confirmed', confirmedAt: new Date().toISOString() };
      if (!profile.name || !profile.address) return json(res, 400, { error: 'Please confirm the salon name and address.' });
      await fs.writeFile(path.join(dataDir, 'salon-profile.json'), JSON.stringify(profile, null, 2));
      return json(res, 200, { ok: true, profile });
    }
    if (url.pathname === '/twilio/sms' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const site = String(body.Body || '').trim();
      if (/^https?:\/\//i.test(site)) {
        await fs.writeFile(path.join(dataDir, 'salon-profile.json'), JSON.stringify({ ownerPhone: body.From || '', website: site, receivedAt: new Date().toISOString() }, null, 2));
        const setupUrl = req.headers.host?.includes('localhost') ? `http://${req.headers.host}` : `https://${req.headers.host}`;
        await sendText(body.From, `Thank you, I’m looking through ${site} now. Connect Google here: ${setupUrl}/api/google/connect. That gives me one permission for Calendar and Sheets.`);
      } else if (body.From) {
        await sendText(body.From, `I’m Mika, your AI receptionist setup assistant. Send me your salon website first, and I’ll learn your services before we connect your calendar.`);
      }
      const twiml = new twilio.twiml.MessagingResponse();
      res.writeHead(200, { 'content-type': 'text/xml' }); return res.end(twiml.toString());
    }
    if (url.pathname === '/api/google/connect') {
      const auth = oauthClient(requestRedirectUri(req));
      const consentUrl = auth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/spreadsheets'] });
      res.writeHead(302, { location: consentUrl }); return res.end();
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
  const connectOpenAI = () => {
    openaiWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-mini'}`, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } });
    openaiWs.on('open', async () => {
      openaiWs.send(JSON.stringify({ type: 'session.update', session: { type: 'realtime', instructions: await receptionistPrompt(), output_modalities: ['audio'], audio: { input: { format: { type: 'audio/pcmu' }, turn_detection: { type: 'server_vad', threshold: 0.7, prefix_padding_ms: 400, silence_duration_ms: 1200, create_response: false, interrupt_response: true } }, output: { format: { type: 'audio/pcmu' }, voice: 'marin' } }, tools: toolDefinitions(), tool_choice: 'auto' } }));
      openaiWs.send(JSON.stringify({ type: 'response.create', response: { instructions: `Say exactly: Hi, ${salonName}, how can I help you?` } }));
    });
    openaiWs.on('message', async (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'response.output_audio.delta' && streamSid) twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
      if (event.type === 'input_audio_buffer.speech_stopped') openaiWs.send(JSON.stringify({ type: 'response.create' }));
      if (event.type === 'response.function_call_arguments.done') {
        try { const args = JSON.parse(event.arguments); const output = await handleTool(event.name, { ...args, phone: args.phone || callerPhone }); openaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify(output) } })); openaiWs.send(JSON.stringify({ type: 'response.create' })); }
        catch (error) { openaiWs.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: event.call_id, output: JSON.stringify({ error: error.message }) } })); openaiWs.send(JSON.stringify({ type: 'response.create' })); }
      }
    });
  };
  twilioWs.on('message', (raw) => { const event = JSON.parse(raw.toString()); if (event.event === 'start') { streamSid = event.start.streamSid; callerPhone = event.start.customParameters?.callerPhone || ''; appendLog({ type: 'call_started', callSid: event.start.callSid || null, phone: callerPhone }); connectOpenAI(); } if (event.event === 'media' && openaiWs?.readyState === WebSocket.OPEN) openaiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: event.media.payload })); });
  twilioWs.on('close', () => openaiWs?.close());
});

server.listen(port, host, () => console.log(`Mika is ready at http://${host}:${port}`));
