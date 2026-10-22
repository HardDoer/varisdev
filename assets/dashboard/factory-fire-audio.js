// Short synthesized robot cries and a quiet flame hiss; no audio downloads.
export function createFactoryFireAudio(window) {
  let context, hiss;
  const voices = new Set();
  const lastCry = new Map();
  let disposed = false;

  function stopVoice(voice) {
    for (const source of voice.sources) {
      try {
        source.stop();
      } catch {
        // A scheduled cry may already have ended.
      }
      source.disconnect();
    }
    for (const node of voice.nodes) node.disconnect();
    voices.delete(voice);
  }
  function start() {
    if (disposed) return;
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) return;
      context ||= new AudioContext();
      void context.resume().catch(() => {});
      if (hiss) return;
      const source = context.createBufferSource();
      const buffer = context.createBuffer(
        1,
        context.sampleRate,
        context.sampleRate,
      );
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++)
        samples[i] = Math.random() * 2 - 1;
      source.buffer = buffer;
      source.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1500;
      const gain = context.createGain();
      gain.gain.value = 0.055;
      source.connect(filter).connect(gain).connect(context.destination);
      hiss = {sources: [source], nodes: [filter, gain]};
      voices.add(hiss);
      source.start();
    } catch {
      stop();
    }
  }
  function scream(id) {
    if (!context || !hiss || disposed) return;
    const now = context.currentTime;
    if (now - (lastCry.get(id) ?? -Infinity) < 1.05 || voices.size >= 5) return;
    if (lastCry.size >= 32) lastCry.delete(lastCry.keys().next().value);
    lastCry.set(id, now);
    const voice = {sources: [], nodes: []};
    voices.add(voice);
    try {
      const gain = context.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.045, now + 0.045);
      gain.gain.setValueAtTime(0.035, now + 0.35);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.8);
      const throat = context.createBiquadFilter();
      throat.type = 'bandpass';
      throat.frequency.value = 1450;
      throat.Q.value = 1.8;
      throat.connect(gain).connect(context.destination);
      const vibrato = context.createOscillator();
      vibrato.frequency.value = 27;
      const wobble = context.createGain();
      wobble.gain.value = 65;
      vibrato.connect(wobble);
      voice.sources.push(vibrato);
      voice.nodes.push(gain, throat, wobble);
      for (const detune of [-14, 14]) {
        const cry = context.createOscillator();
        cry.type = 'sawtooth';
        cry.detune.value = detune;
        cry.frequency.setValueAtTime(480, now);
        cry.frequency.exponentialRampToValueAtTime(1050, now + 0.12);
        cry.frequency.exponentialRampToValueAtTime(560, now + 0.8);
        wobble.connect(cry.frequency);
        cry.connect(throat);
        voice.sources.push(cry);
      }
      vibrato.onended = () => stopVoice(voice);
      for (const source of voice.sources) {
        source.start(now);
        source.stop(now + 0.82);
      }
    } catch {
      stopVoice(voice);
    }
  }
  function stop() {
    for (const voice of [...voices]) stopVoice(voice);
    hiss = undefined;
    lastCry.clear();
  }
  return {
    start,
    scream,
    stop,
    dispose() {
      disposed = true;
      stop();
      if (context) void context.close().catch(() => {});
      context = undefined;
    },
  };
}
