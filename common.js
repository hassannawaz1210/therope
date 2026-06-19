// Shared rope client: pull input, WebAudio SFX, SSE state. Themes only supply a render(state, winner).
window.Rope = (() => {
  const WIN = 100;

  // ---- sound: WebAudio synth, no files ----
  let actx;
  const audio = () => (actx ||= new (window.AudioContext || window.webkitAudioContext)());
  function tone(freq, dur, type = "square", gain = 0.05, at = 0) {
    const a = audio(), t = a.currentTime + at;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.value = freq; o.connect(g); g.connect(a.destination);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur);
  }
  let flip = 0;
  const tick = () => tone(flip++ % 2 ? 200 : 150, 0.04, "square", 0.04);
  const fanfare = () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, "triangle", 0.08, i * 0.1));

  // ---- tap-to-pull: one pull per discrete press/click/tap (no holding) ----
  let sid = "";   // session id issued by /stream; the server rejects pulls without it
  const pull = (side) => { if (sid) { navigator.sendBeacon("/pull?side=" + side + "&s=" + sid); tick(); } };

  function bindSides(leftEl, rightEl) {
    for (const [el, side] of [[leftEl, "left"], [rightEl, "right"]]) {
      el.addEventListener("pointerdown", (e) => { e.preventDefault(); audio().resume?.(); pull(side); });
    }
    // ← / → arrow keys: each press = one pull; e.repeat blocks OS key-repeat so holding does nothing
    const keySide = (k) => (k === "ArrowLeft" ? "left" : k === "ArrowRight" ? "right" : null);
    addEventListener("keydown", (e) => {
      const s = keySide(e.key);
      if (s && !e.repeat) { e.preventDefault(); audio().resume?.(); pull(s); }
    });
  }

  // render(state, winner) — winner is "left"|"right" the frame someone crosses an edge, else null.
  // render(null, null) is called on a stream error so the theme can show "reconnecting".
  let lastWins = null;
  function connect(render) {
    const es = new EventSource("/stream");
    es.addEventListener("session", (e) => { sid = JSON.parse(e.data).id; });
    es.onmessage = (e) => {
      const s = JSON.parse(e.data);
      let winner = null;
      if (lastWins) {
        if (s.wins.left  > lastWins.left)  winner = "left";
        if (s.wins.right > lastWins.right) winner = "right";
      }
      if (winner) fanfare();
      lastWins = s.wins;
      render(s, winner);
    };
    es.onerror = () => render(null, null);
  }

  // map pos (-WIN..WIN) to a 0..1 fraction with a 5% margin at each edge
  const frac = (pos) => 0.05 + ((pos + WIN) / (2 * WIN)) * 0.9;

  return { WIN, bindSides, connect, frac };
})();
