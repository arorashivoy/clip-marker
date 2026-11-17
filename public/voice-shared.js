// Shared code of the voice commands, for the main page and the voice test.
// The speech engine (Vosk) runs in the browser. This file only chooses the microphone and finds the commands.
(() => {
  const read = (key, fallback) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
  const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* private window */ } };

  const settings = {
    wakeWord: () => read('wakeWord', 'mark'),
    minConf: () => { const n = Number(read('voiceConf', '')); return n > 0 && n < 1 ? n : 0.7; },
    setMinConf: (n) => { if (Number(n) > 0 && Number(n) < 1) write('voiceConf', String(Number(n))); },
    fast: () => read('voiceFast', '1') === '1',
    setFast: (on) => write('voiceFast', on ? '1' : '0'),
    micId: () => read('voiceMic', ''),
    setMicId: (id) => write('voiceMic', id || ''),
  };

  const AUDIO = { echoCancellation: true, noiseSuppression: true, channelCount: 1 };

  // Open the selected microphone. If it is not connected now, use the default microphone.
  async function openMic() {
    const id = settings.micId();
    if (id) {
      try {
        return { stream: await navigator.mediaDevices.getUserMedia({ video: false, audio: { ...AUDIO, deviceId: { exact: id } } }), fallback: false };
      } catch (e) {
        if (e.name !== 'OverconstrainedError' && e.name !== 'NotFoundError') throw e;
      }
    }
    return { stream: await navigator.mediaDevices.getUserMedia({ video: false, audio: AUDIO }), fallback: Boolean(id) };
  }

  // Fill a <select> with the microphones. The browser gives the names only after it allows the microphone.
  async function fillMics(select) {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let mics = [];
    try { mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'); } catch { /* no access */ }
    const id = settings.micId();
    const named = mics.some((m) => m.label);
    select.innerHTML = `<option value="">Default of the browser</option>` + mics.map((m, i) =>
      `<option value="${esc(m.deviceId)}"${m.deviceId === id ? ' selected' : ''}>${esc(m.label || `Microphone ${i + 1}`)}</option>`).join('')
      + (id && !mics.some((m) => m.deviceId === id) ? `<option value="${esc(id)}" selected>The saved microphone (not connected)</option>` : '');
    return named;
  }

  // "mark <name>" for a usual button. "start <name>" and "end <name>" for a Start/End button.
  const spoken = (label) => String(label).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean).join(' ');
  function commandsOf(game) {
    const list = [];
    for (const t of game?.terms || []) {
      const name = spoken(t.label);
      if (!name) continue;
      for (const verb of t.range ? ['start', 'end'] : [settings.wakeWord()]) list.push({ phrase: `${verb} ${name}`, verb, termId: t.id, label: t.label });
    }
    return list.sort((a, b) => b.phrase.length - a.phrase.length); // try the longest name first
  }

  // The commands in a list of words, in order, without overlap.
  function findAll(tokens, commands) {
    const hits = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const cmd = commands.find((c) => c.phrase.split(' ').every((w, k) => tokens[i + k] === w));
      if (!cmd) continue;
      hits.push({ cmd, i });
      i += cmd.phrase.split(' ').length - 1;
    }
    return hits;
  }

  // Follows one utterance of the engine, from the first partial result to the final result.
  // Fast detection acts on a command when two partial results in a row agree on it.
  // It does not act on a command that can still become a longer command, for example "mark close" and "mark close call".
  // The final result acts only on the commands that the partial results did not act on.
  const RECOGNITION_MS = 300; // the time between the end of a word and its first partial result, about
  function tracker(getCommands) {
    let fired = 0, prev = [], seen = [];
    const reset = () => { fired = 0; prev = []; seen = []; };
    return {
      reset,
      partial(text) {
        const now = Date.now();
        const tokens = text ? text.split(' ') : [];
        for (let i = seen.length; i < tokens.length; i += 1) seen[i] = now;
        if (!settings.fast() || !tokens.length) { prev = []; return []; }
        const commands = getCommands();
        const cur = findAll(tokens, commands);
        const out = [];
        while (fired < cur.length && fired < prev.length) {
          const h = cur[fired], p = prev[fired];
          if (h.cmd.phrase !== p.cmd.phrase || h.i !== p.i) break;
          const end = h.i + h.cmd.phrase.split(' ').length;
          if (end === tokens.length && commands.some((c) => c.phrase.startsWith(h.cmd.phrase + ' '))) break;
          out.push({ cmd: h.cmd, conf: null, agoMs: Math.max(0, now - (seen[h.i] ?? now)) + RECOGNITION_MS, fast: true });
          fired += 1;
        }
        prev = cur;
        return out;
      },
      // `detail` has the confidence and the start time of each word. `t0` is the time of the first audio block.
      final(text, detail, t0) {
        const now = Date.now();
        const tokens = text ? text.split(' ') : [];
        const aligned = detail.length === tokens.length;
        const out = [];
        findAll(tokens, getCommands()).slice(fired).forEach((h) => {
          const n = h.cmd.phrase.split(' ').length;
          const conf = aligned ? Math.min(...detail.slice(h.i, h.i + n).map((d) => d.conf)) : 1;
          const agoMs = aligned && t0 ? Math.max(0, now - (t0 + detail[h.i].start * 1000)) : 0;
          out.push({ cmd: h.cmd, conf, agoMs, fast: false, low: conf < settings.minConf() });
        });
        reset();
        return out;
      },
    };
  }

  window.VoiceShared = { settings, openMic, fillMics, commandsOf, tracker, findAll };
})();
