import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachLiveBridge } from './live-bridge.mjs';

class FakeSocket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
  receive(event) { this.emit('message', Buffer.from(JSON.stringify(event))); }
  close() { this.readyState = 3; this.emit('close', 1000); }
  terminate() { this.close(); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, executeTool = async () => ({ slots: [] }), options = {}) {
  const phone = new FakeSocket();
  let ai;
  class Connection extends FakeSocket {
    constructor(url, config) { super(); this.url = url; this.config = config; ai = this; }
  }
  attachLiveBridge(phone, {
    apiKey: 'test-only', salonName: 'Test Salon', getInstructions: async () => 'Never invent availability.',
    getVoiceContext: async () => 'Tomorrow is 2026-09-17. Opening hours: noon to 7:30 PM.',
    tools: [{ type: 'function', name: 'check_availability', parameters: { type: 'object' } }],
    executeTool, Socket: Connection, closeTimeoutMs: 1, ...options,
  });
  t.after(() => { phone.close(); ai?.close(); });
  phone.receive({ event: 'start', start: { streamSid: 'MZtest', callSid: 'CAtest', customParameters: { callerPhone: '+15555550100' } } });
  await tick();
  ai?.emit('open');
  return { phone, ai, ready() { ai.receive({ type: 'session.started', session: { id: 'live_test' } }); } };
}

test('Live handshake, buffered PCMU, acknowledged greeting and bidirectional audio', async t => {
  const { phone, ai, ready } = await setup(t);
  assert.equal(ai.url, 'wss://api.openai.com/v1/live/sessions');
  assert.equal(ai.sent[0].type, 'session.start');
  assert.equal(ai.sent[0].session.model, 'gpt-live-1');
  assert.match(ai.sent[0].session.instructions, /Answer known salon questions directly/);
  assert.match(ai.sent[0].session.instructions, /Do not delegate for supplied service descriptions/);
  assert.match(ai.sent[0].session.input[0].content[0].text, /Tomorrow is 2026-09-17/);
  assert.match(ai.sent[0].session.input[0].content[0].text, /returning client/);
  assert.deepEqual(ai.sent[0].session.audio.format, { type: 'audio/pcmu', rate: 8000 });
  phone.receive({ event: 'media', media: { payload: 'early' } });
  assert.equal(ai.sent.length, 1);
  ready();
  assert.equal(ai.sent.at(-1).audio, 'early');
  assert.ok(!ai.sent.some(event => event.type === 'session.commentary.append'));
  ai.receive({ type: 'session.instructions.appended', client_event_id: 'phone_greeting' });
  ai.receive({ type: 'session.instructions.appended', client_event_id: 'phone_greeting' });
  assert.equal(ai.sent.filter(event => event.type === 'session.commentary.append').length, 1);
  phone.receive({ event: 'media', media: { payload: 'next' } });
  assert.deepEqual(ai.sent.at(-1), { type: 'session.input_audio.append', audio: 'next' });
  ai.receive({ type: 'session.output_audio.delta', delta: 'spoken' });
  assert.deepEqual(phone.sent.at(-1), { event: 'media', streamSid: 'MZtest', media: { payload: 'spoken' } });
  assert.ok(!ai.sent.some(event => ['response.create', 'session.update', 'input_audio_buffer.append'].includes(event.type)));
});

function response(ai, event) { ai.receive({ type: 'response.event', delegation_id: 'delegation1', event }); }
function tool(ai, id = 'call1', args = '{"date":"2026-09-20"}') {
  response(ai, { type: 'response.output_item.done', item: { type: 'function_call', name: 'check_availability', call_id: id, arguments: args } });
}
function startResponse(ai, id) { response(ai, { type: 'response.created', response: { id, output: [] } }); }
function complete(ai, id) { response(ai, { type: 'response.completed', response: { id, output: [] } }); }

test('nested function items survive empty terminal snapshots; results precede one continuation', async t => {
  const calls = [];
  const { ai, ready } = await setup(t, async (...args) => { calls.push(args); return { slots: ['verified'] }; });
  ready();
  startResponse(ai, 'r1');
  tool(ai);
  tool(ai);
  tool(ai, 'call2');
  assert.equal(calls.length, 0);
  complete(ai, 'r1');
  complete(ai, 'r1');
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].phone, '+15555550100');
  assert.equal(calls[0][2].callSid, 'CAtest');
  assert.deepEqual(ai.sent.slice(-3).map(event => event.type), ['response.item.create', 'response.item.create', 'response.create']);
  assert.deepEqual(ai.sent.at(-1), { type: 'response.create' });
  startResponse(ai, 'r2');
  tool(ai);
  complete(ai, 'r2');
  await tick();
  assert.equal(calls.length, 2, 'duplicate call ID must not repeat a side effect');
});

test('malformed tool arguments become a tool failure, not a booking execution', async t => {
  let executed = false;
  const { ai, ready } = await setup(t, async () => { executed = true; });
  ready(); startResponse(ai, 'r1'); tool(ai, 'bad', '{'); complete(ai, 'r1');
  await tick();
  assert.equal(executed, false);
  assert.ok(JSON.parse(ai.sent.at(-2).item.output).error);
});

test('hangup stops pending tool continuations and gracefully closes Live', async t => {
  let resolve;
  const { phone, ai, ready } = await setup(t, () => new Promise(r => { resolve = r; }));
  ready(); startResponse(ai, 'r1'); tool(ai); complete(ai, 'r1');
  await tick();
  phone.receive({ event: 'stop' });
  assert.equal(ai.sent.at(-1).type, 'session.close');
  resolve({ slots: [] });
  await tick();
  assert.ok(!ai.sent.some(event => event.type === 'response.item.create'));
});

test('API rejection closes Twilio stream for spoken fallback', async t => {
  const { phone, ai } = await setup(t);
  ai.receive({ type: 'error', error: { message: 'Model unavailable' } });
  assert.equal(phone.readyState, 3);
  assert.equal(ai.readyState, 3);
});

test('failed backend responses never execute collected function calls', async t => {
  let executed = false;
  const { ai, ready } = await setup(t, async () => { executed = true; });
  ready(); startResponse(ai, 'failed'); tool(ai);
  response(ai, { type: 'response.failed', response: { id: 'failed', error: { message: 'Backend unavailable' } } });
  await tick();
  assert.equal(executed, false);
  assert.equal(ai.sent.at(-1).type, 'session.commentary.append');
  assert.ok(!ai.sent.some(event => event.type === 'response.create'));
});

test('startup timeout closes the call stream instead of waiting silently', async t => {
  const { phone } = await setup(t, undefined, { startupTimeoutMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(phone.readyState, 3);
});
