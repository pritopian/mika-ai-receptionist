export function localDay(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function resolveBookingDay(value, timezone, now = new Date()) {
  const today = localDay(now, timezone);
  const base = new Date(`${today}T12:00:00Z`);
  const input = String(value || 'today').trim().toLowerCase();
  let offset = { today: 0, tomorrow: 1, 'day after tomorrow': 2 }[input];
  if (offset === undefined) {
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const index = weekdays.indexOf(input);
    if (index >= 0) offset = (index - base.getUTCDay() + 7) % 7;
  }
  let result = input;
  if (offset !== undefined) {
    base.setUTCDate(base.getUTCDate() + offset);
    result = base.toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || Number.isNaN(Date.parse(`${result}T12:00:00Z`)) || new Date(`${result}T12:00:00Z`).toISOString().slice(0, 10) !== result) {
    throw new Error('The requested date is unclear. Clarify only the ambiguous day, not the current month or year.');
  }
  if (result < today) throw new Error('That date is in the past. Ask which upcoming day the caller means.');
  return result;
}

export function clockContext(timezone, now = new Date()) {
  return `Current salon-local date and time: ${now.toLocaleString('en-US', { timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. Timezone: ${timezone}. Today is ${localDay(now, timezone)}. Tomorrow is ${resolveBookingDay('tomorrow', timezone, now)}. Resolve today, tomorrow, and weekdays using this clock; never ask the caller for the current date, month, or year. Confirm naturally using the weekday. Ask only when their requested date is genuinely ambiguous.`;
}

export function withinBusinessWindow(slot, window, now = new Date()) {
  const start = Date.parse(slot.start);
  const end = Date.parse(slot.end);
  return Boolean(window && Number.isFinite(start) && Number.isFinite(end) && end > start && start >= now.getTime() && start >= window.start.getTime() && end <= window.end.getTime());
}

export function selectBookableService(services, requested) {
  const query = String(requested || '').trim().toLowerCase();
  if (!query) throw new Error('Ask whether the caller wants a manicure, pedicure, or both.');
  const exact = services.find(item => item.name.toLowerCase() === query);
  if (exact) return exact;
  const generic = { mani: 'manicure', manicure: 'manicure', pedi: 'pedicure', pedicure: 'pedicure' }[query];
  if (generic) {
    const candidates = services.filter(item => item.name.toLowerCase().includes(generic) && !/gel|dip|acrylic|fullset|hard|soft|removal|art|repair|fill/i.test(item.name));
    const preferred = candidates.filter(item => generic === 'manicure' ? /regular|classic|basic/i.test(item.name) : /express|regular|classic|basic/i.test(item.name));
    if (preferred.length === 1) return preferred[0];
    if (candidates.length === 1) return candidates[0];
    throw new Error(`A default ${generic} is not configured unambiguously in the connected booking catalog. Do not ask the caller to browse the menu or substitute an unrelated service. Explain that online scheduling needs salon setup.`);
  }
  const matches = services.filter(item => item.name.toLowerCase().includes(query));
  if (matches.length === 1) return matches[0];
  throw new Error(`The requested service is not uniquely available in the connected booking catalog. Do not invent a service or book a partial replacement for ${requested}.`);
}

export function selectTechnician(profiles, requested) {
  const query = String(requested || '').trim().toLowerCase();
  if (!query || /^(any|anyone|no preference|available team member)$/.test(query)) return '';
  const matches = profiles.filter(person => person.is_bookable && (person.team_member_id.toLowerCase() === query || person.display_name?.toLowerCase() === query));
  if (matches.length !== 1) throw new Error('That technician could not be matched uniquely in the booking system. Ask for their full name or whether any available technician is okay. Do not silently choose someone else.');
  return matches[0].team_member_id;
}
