// Opt-in API smoke test: npm dependencies and OPENAI_API_KEY are required.
// Uses synthetic silence and no real booking tools; incurs a short Live API session.
import 'dotenv/config';
import { EventEmitter } from 'node:events';
import { attachLiveBridge } from './live-bridge.mjs';

if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required.');
let active = false;
let audioFrames = 0;
let speechFrames = 0;
let finished = false;
let timer;
let deadline;
class TestPhone extends EventEmitter {
  readyState = 1;
  send(raw) {
    const event = JSON.parse(raw);
    if (event.event !== 'media') return;
    audioFrames++;
    const bytes = Buffer.from(event.media.payload, 'base64');
    if (bytes.some(byte => byte !== 255 && byte !== 127)) speechFrames++;
    if (speechFrames >= 10) stop(true);
  }
  close() { this.readyState = 3; this.emit('close'); if (!finished) stop(false); }
}
const phone = new TestPhone();
function stop(success) {
  if (finished) return;
  finished = true;
  clearInterval(timer);
  clearTimeout(deadline);
  console.log(JSON.stringify({ sessionStarted: active, audioFrames, speechFrames, passed: success }));
  process.exitCode = success ? 0 : 1;
  phone.close();
}
attachLiveBridge(phone, {
  apiKey: process.env.OPENAI_API_KEY, model: 'gpt-live-1',
  backendModel: process.env.OPENAI_LIVE_BACKEND_MODEL || 'gpt-5.6-luna',
  salonName: 'the test salon', getInstructions: async () => 'This is a synthetic audio test. Do not make bookings.',
  tools: [], executeTool: async () => { throw new Error('No real tools in a smoke test.'); },
  log: async entry => { if (entry.type === 'voice_connected') active = true; },
});
phone.emit('message', Buffer.from(JSON.stringify({ event: 'start', start: {
  streamSid: 'synthetic', callSid: 'synthetic', mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
} })));
const payload = Buffer.alloc(160, 255).toString('base64');
timer = setInterval(() => phone.emit('message', Buffer.from(JSON.stringify({ event: 'media', media: { payload } }))), 20);
deadline = setTimeout(() => stop(false), 30000);
