import { WebSocket } from 'ws';

export function attachLiveBridge(twilioWs, {
  apiKey, model = 'gpt-live-1', backendModel = 'gpt-5.6-luna', salonName,
  getInstructions, getVoiceContext = async () => '', tools, executeTool, log = async () => {},
  Socket = WebSocket, startupTimeoutMs = 20000, closeTimeoutMs = 5000,
}) {
  let socket;
  let streamSid;
  let ready = false;
  let ended = false;
  let greetingSent = false;
  let startupTimer;
  let closeTimer;
  const pendingAudio = [];
  const responses = new Map();
  const delegationResponses = new Map();
  const completedResponses = new Set();
  const toolResults = new Map();
  let toolQueue = Promise.resolve();
  const context = { callSid: null, phone: '', lastAvailabilitySlots: [] };

  function record(type, details) {
    console[type === 'voice_error' ? 'error' : 'log'](details);
    Promise.resolve().then(() => log({ type, callSid: context.callSid, phone: context.phone, details }))
      .catch(error => console.error(`Voice activity logging failed: ${error.message}`));
  }
  function send(event) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(event));
    return true;
  }
  function finish() {
    if (ended) return;
    ended = true;
    clearTimeout(startupTimer);
    pendingAudio.length = 0;
    if (ready && send({ type: 'session.close' })) {
      closeTimer = setTimeout(() => socket.terminate(), closeTimeoutMs);
      closeTimer.unref?.();
    } else if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }
  function fail(message) {
    if (ended) return;
    record('voice_error', `OpenAI Live: ${message}`);
    finish();
    // Closing the stream resumes the fallback Say after Connect in TwiML.
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  }

  async function continueTools(state) {
    for (const item of state.calls.values()) {
      if (ended) return;
      if (!toolResults.has(item.call_id)) {
        const result = (async () => {
          try {
            const args = JSON.parse(item.arguments);
            if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments.');
            if (!tools.some(tool => tool.name === item.name)) throw new Error('Unknown tool.');
            return await executeTool(item.name, { ...args, phone: args.phone || context.phone }, context);
          } catch (error) {
            record('tool_error', `${item.name}: ${error.message}`);
            return { error: error.message, instruction: 'Do not claim success or retry a booking automatically. Clarify or verify the outcome first.' };
          }
        })();
        toolResults.set(item.call_id, result);
      }
      const output = await toolResults.get(item.call_id);
      if (ended) return;
      send({ type: 'response.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(output) } });
    }
    if (!ended && state.calls.size) send({ type: 'response.create' });
  }

  function onResponse(envelope) {
    const event = envelope.event;
    if (!event) return;
    if (event.type === 'response.created') delegationResponses.set(envelope.delegation_id, event.response.id);
    const key = event.response_id || event.response?.id || delegationResponses.get(envelope.delegation_id);
    if (!key || completedResponses.has(key)) return;
    let state = responses.get(key);
    if (!state) {
      state = { calls: new Map() };
      responses.set(key, state);
    }
    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      state.calls.set(event.item.call_id, event.item);
    }
    if (['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) {
      completedResponses.add(key);
      responses.delete(key);
      if (event.type === 'response.completed') {
        toolQueue = toolQueue.then(() => continueTools(state)).catch(error => fail(error.message));
      } else {
        record('voice_error', `Live booking backend ${event.type}: ${event.response?.error?.message || 'No completed result'}`);
        send({ type: 'session.commentary.append', delegation_id: null, content: 'The backend could not complete this request. No successful booking has been confirmed. Apologize and do not claim success.' });
      }
    }
  }

  async function connect() {
    if (!apiKey) return fail('OPENAI_API_KEY is not configured.');
    startupTimer = setTimeout(() => fail('Session startup timed out.'), startupTimeoutMs);
    startupTimer.unref?.();
    const instructions = await getInstructions();
    const voiceContext = await getVoiceContext();
    if (ended) return;
    socket = new Socket('wss://api.openai.com/v1/live/sessions', { headers: { Authorization: `Bearer ${apiKey}` } });
    socket.on('open', () => {
      if (ended) return socket.close();
      send({ type: 'session.start', session: {
        model,
        instructions: `You are Mika, a warm, concise phone receptionist for ${salonName}. Speak English unless the caller requests another language.\nBackchannel policy: Use moderate backchannels.\nInterruption policy: Stop speaking when interrupted and listen.\nDelegation policy:\nBackend tools: salon service and hours information, appointment availability, and creating bookings.\nDelegate to the backend when the caller asks about services, hours, prices, availability, booking, or corrects a pending booking request. Delegate before answering questions that depend on that information. Never guess availability, prices, or a booking result.\nDo not delegate for greetings, simple clarification, or repeating a confirmed result. Ask one question at a time. Never claim a booking or text confirmation succeeded without backend confirmation.`,
        input: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: `${voiceContext}\nBooking conversation: Accept manicure, pedicure, or both without reciting the menu or asking about variants, gel, or nail art unless the caller volunteers them. The backend maps a generic request to the configured basic service; never silently substitute a specialty service. Ask if they have visited before. For a returning client, ask whether they want a particular technician; if not, use any available technician. Capture that preference before checking openings. Do not repeat already answered questions. Resolve tomorrow from the supplied local clock, without asking for the month or year. Ask one brief question at a time. Both services must actually be supported before promising a combined appointment.` }] }],
        audio: { format: { type: 'audio/pcmu', rate: 8000 }, output: { voice: 'marin' } },
        delegation: { type: 'responses', responses: {
          model: backendModel,
          instructions: `${instructions}\n\nYou are Mika's booking backend for a live phone conversation. Return concise, factual guidance for the voice model. Use tools for availability and bookings, never invented slots. Offer at most three exact returned slots. Collect a real name and the caller's choice of a returned slot before booking. Do not retry a booking with an uncertain outcome. Distinguish booking success from SMS delivery and report failures honestly.`,
          tools: tools.map(tool => ({ ...tool, strict: false })),
          tool_choice: 'auto', parallel_tool_calls: false,
        } },
      } });
    });
    socket.on('message', raw => {
      try {
        const event = JSON.parse(raw.toString());
        if (event.type === 'session.closed') {
          if (!ended) fail(`Session ended: ${event.reason || 'unknown reason'}`);
          clearTimeout(closeTimer);
          socket.close();
          return;
        }
        if (ended) return;
        if (event.type === 'error') return fail(event.error?.message || 'Session rejected a command.');
        if (event.type === 'session.started' && !ready) {
          ready = true;
          clearTimeout(startupTimer);
          record('voice_connected', `OpenAI Live session started (${model}; booking backend ${backendModel}).`);
          send({ type: 'session.instructions.append', event_id: 'phone_greeting', delegation_id: null,
            content: `Speak English. Speak first and welcome the caller: "Hi, this is Mika, the AI receptionist for ${salonName}. How can I help you?" Then listen. If the caller has already asked a question, acknowledge it rather than repeating the welcome.` });
          for (const audio of pendingAudio.splice(0)) send({ type: 'session.input_audio.append', audio });
        }
        if (event.type === 'session.instructions.appended' && event.client_event_id === 'phone_greeting' && !greetingSent) {
          greetingSent = true;
          send({ type: 'session.commentary.append', delegation_id: null, content: 'The caller is connected. Begin the welcome now, then listen.' });
        }
        if (event.type === 'session.output_audio.delta' && streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({ event: 'media', streamSid, media: { payload: event.delta } }));
        }
        if (event.type === 'response.event') onResponse(event);
      } catch (error) { fail(error.message); }
    });
    socket.on('error', error => fail(error.message));
    socket.on('close', code => {
      clearTimeout(closeTimer);
      if (!ended) fail(`Connection closed unexpectedly (${code}).`);
    });
  }

  twilioWs.on('message', raw => {
    if (ended) return;
    try {
      const event = JSON.parse(raw.toString());
      if (event.event === 'start' && !streamSid) {
        const format = event.start.mediaFormat;
        if (format && (format.encoding !== 'audio/x-mulaw' || format.sampleRate !== 8000 || format.channels !== 1)) {
          return fail('Unsupported Twilio audio format. Expected mono mu-law at 8000 Hz.');
        }
        streamSid = event.start.streamSid;
        context.callSid = event.start.callSid || null;
        context.phone = event.start.customParameters?.callerPhone || '';
        record('call_started', 'Twilio media connected; starting OpenAI Live.');
        void connect().catch(error => fail(error.message));
      }
      if (event.event === 'media' && streamSid && typeof event.media?.payload === 'string') {
        if (ready) send({ type: 'session.input_audio.append', audio: event.media.payload });
        else {
          // Bound startup buffering to roughly ten seconds of Twilio's 20 ms frames.
          if (pendingAudio.length >= 500) return fail('Audio startup buffer exceeded.');
          pendingAudio.push(event.media.payload);
        }
      }
      if (event.event === 'stop') finish();
    } catch (error) { fail(error.message); }
  });
  twilioWs.on('close', finish);
  twilioWs.on('error', error => fail(`Twilio transport: ${error.message}`));
}
