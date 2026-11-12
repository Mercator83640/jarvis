/**
 * Microphone level, measured on the audio thread.
 *
 * Voice detection (vad.ts) and the clap (clap.ts) both need a steady stream of
 * "how loud is the room right now". They used to read an AnalyserNode once per
 * requestAnimationFrame — and Chrome stops calling requestAnimationFrame
 * entirely while the tab is hidden: minimised, behind another tab, or covered
 * by another window. The microphone stayed open and nobody listened to it, so
 * JARVIS went deaf the moment you looked at something else.
 *
 * Timers are no substitute: hidden tabs get setInterval clamped to once a
 * second, then once a minute. The audio thread is the one thing Chrome keeps
 * running in the background, so the measurement happens there, in an
 * AudioWorklet, and each reading is posted back with its audio-clock time.
 *
 * Readings arrive at HOP_HZ — the old frame rate — so the detectors' tuning,
 * which counts frames in places, means what it always meant. Each one is the
 * RMS of the last `window` samples, exactly what getFloatTimeDomainData gave.
 */

const HOP_HZ = 60

const PROCESSOR = /* js */ `
class JarvisRmsTap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const o = options.processorOptions
    this.ring = new Float32Array(o.window)
    this.pos = 0
    this.filled = 0
    this.hop = Math.max(128, sampleRate / o.hopHz)
    this.since = 0
    this.alive = true
    this.port.onmessage = (e) => { if (e.data === 'stop') this.alive = false }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return this.alive
    const ring = this.ring
    for (let i = 0; i < ch.length; i++) {
      ring[this.pos] = ch[i]
      this.pos = (this.pos + 1) % ring.length
      if (this.filled < ring.length) this.filled++
    }
    this.since += ch.length
    if (this.since >= this.hop) {
      // Carry the remainder: render blocks are 128 samples, so resetting to 0
      // would round every hop up and drift the rate below HOP_HZ.
      this.since -= this.hop
      let sum = 0
      for (let i = 0; i < this.filled; i++) sum += ring[i] * ring[i]
      const rms = this.filled ? Math.sqrt(sum / this.filled) : 0
      this.port.postMessage({ rms, t: currentTime * 1000 })
    }
    return this.alive
  }
}
registerProcessor('jarvis-rms-tap', JarvisRmsTap)
`

let moduleUrl = ''
const registered = new WeakMap<BaseAudioContext, Promise<void>>()

function register(ctx: AudioContext): Promise<void> {
  let p = registered.get(ctx)
  if (!p) {
    if (!moduleUrl) {
      moduleUrl = URL.createObjectURL(new Blob([PROCESSOR], { type: 'text/javascript' }))
    }
    p = ctx.audioWorklet.addModule(moduleUrl)
    registered.set(ctx, p)
  }
  return p
}

export type LevelMeter = { stop: () => void }

/**
 * Call `onLevel(rms, tMs)` about 60 times a second with the RMS of the last
 * `window` samples of `source`. `tMs` is the audio clock in milliseconds —
 * compare readings with each other, not with performance.now().
 */
export async function startLevelMeter(
  ctx: AudioContext,
  source: AudioNode,
  window: number,
  onLevel: (rms: number, tMs: number) => void,
): Promise<LevelMeter> {
  if (ctx.audioWorklet) {
    try {
      await register(ctx)
      const node = new AudioWorkletNode(ctx, 'jarvis-rms-tap', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        // Downmix to mono, as AnalyserNode's time-domain read did.
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
        processorOptions: { window, hopHz: HOP_HZ },
      })
      // A node with no path to the destination may never be pulled, so give it
      // one — through a muted gain, so the microphone is not played back.
      const mute = ctx.createGain()
      mute.gain.value = 0
      source.connect(node)
      node.connect(mute)
      mute.connect(ctx.destination)

      let stopped = false
      node.port.onmessage = (e: MessageEvent<{ rms: number; t: number }>) => {
        if (!stopped) onLevel(e.data.rms, e.data.t)
      }
      return {
        stop: () => {
          if (stopped) return
          stopped = true
          node.port.onmessage = null
          node.port.postMessage('stop')
          try {
            source.disconnect(node)
            node.disconnect()
            mute.disconnect()
          } catch {
            /* already gone */
          }
        },
      }
    } catch (err) {
      console.warn('[jarvis] AudioWorklet unavailable, falling back to frame-rate metering', err)
    }
  }

  // Fallback: the old way. Works while the tab is visible, stops when hidden.
  const analyser = ctx.createAnalyser()
  analyser.fftSize = window
  source.connect(analyser)
  const buf = new Float32Array(analyser.fftSize)
  let raf = 0
  let stopped = false
  const tick = () => {
    if (stopped) return
    raf = requestAnimationFrame(tick)
    analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
    onLevel(Math.sqrt(sum / buf.length), performance.now())
  }
  tick()
  return {
    stop: () => {
      stopped = true
      cancelAnimationFrame(raf)
      try {
        source.disconnect(analyser)
      } catch {
        /* already gone */
      }
    },
  }
}
