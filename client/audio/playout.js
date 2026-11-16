// Remote audio playout and the far-end reference bus for our echo canceller.
//
// Normally each remote audio track plays through its own <audio> element (unchanged app behaviour).
// When "Ours" runs with echo cancellation, playout is routed through Web Audio instead, so the AEC
// receives exactly what is sent to the speakers:
//
//   remote track ─► MediaStreamSource ─┬─► speaker bus ─► AudioContext.destination (speakers)
//                                      └─► reference bus ─► AEC (input 1)
//   local screen-share sound ─────────────► reference bus only (the shared tab already plays it itself)
//
// Chrome only delivers remote WebRTC audio to Web Audio while the track is also attached to a media
// element, so the elements stay attached but muted while routed.
export function createPlayout() {
  const remotes = new Map(); // id -> { el, track }
  let graph = null, localScreen = null;
  function connect(id, item) {
    if (!graph || graph.sources.has(id) || item.track.readyState !== 'live') return;
    item.el.muted = true;
    const source = graph.ctx.createMediaStreamSource(new MediaStream([item.track]));
    source.connect(graph.speakers); source.connect(graph.reference);
    graph.sources.set(id, source);
  }
  function disconnect(id) {
    const source = graph?.sources.get(id);
    if (source) { source.disconnect(); graph.sources.delete(id); }
  }
  function connectScreen() {
    graph?.screen?.disconnect(); if (graph) graph.screen = null;
    if (!graph || !localScreen || localScreen.readyState !== 'live') return;
    graph.screen = graph.ctx.createMediaStreamSource(new MediaStream([localScreen]));
    graph.screen.connect(graph.reference);
  }
  return {
    get routed() { return Boolean(graph); },
    get count() { return remotes.size; },
    add(id, el, track) {
      remotes.set(id, { el, track });
      if (graph) connect(id, remotes.get(id));
    },
    remove(id) { disconnect(id); remotes.delete(id); },
    setLocalScreenAudio(track) { localScreen = track || null; connectScreen(); },
    // Play remote audio through ctx and return the reference bus node (a GainNode) for the AEC.
    route(ctx) {
      this.unroute();
      const speakers = ctx.createGain(), reference = ctx.createGain();
      speakers.connect(ctx.destination);
      graph = { ctx, speakers, reference, sources: new Map(), screen: null };
      for (const [id, item] of remotes) connect(id, item);
      connectScreen();
      return reference;
    },
    // Back to the <audio> elements.
    unroute() {
      if (!graph) return;
      for (const source of graph.sources.values()) source.disconnect();
      graph.screen?.disconnect(); graph.speakers.disconnect(); graph.reference.disconnect();
      graph = null;
      for (const { el } of remotes.values()) { el.muted = false; el.play?.().catch(() => {}); }
    },
    clear() { this.unroute(); remotes.clear(); localScreen = null; },
  };
}
