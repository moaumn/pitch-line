// Worker global state
const SAMPLE_RATE = 16000;
const WINDOW_SIZE = 1024;
const HOP_SIZE = 512;

// YIN parameters
const YIN_THRESHOLD = 0.15;
const MIN_FREQ = 60; // MIDI 36 (C2)
const MAX_FREQ = 1000; // MIDI 88 (C6)

// 1. Resample PCM using linear interpolation
function resamplePCM(oldPCM, oldSampleRate, newSampleRate) {
  if (oldSampleRate === newSampleRate) return oldPCM;
  const ratio = oldSampleRate / newSampleRate;
  const newLength = Math.round(oldPCM.length / ratio);
  const newPCM = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const oldIdx = i * ratio;
    const left = Math.floor(oldIdx);
    const right = Math.min(oldPCM.length - 1, left + 1);
    const weight = oldIdx - left;
    newPCM[i] = oldPCM[left] * (1 - weight) + oldPCM[right] * weight;
  }
  return newPCM;
}

// 2. YIN difference function
function yinDifference(buffer, windowSize, maxShift) {
  const diff = new Float32Array(maxShift);
  for (let tau = 1; tau < maxShift; tau++) {
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const delta = buffer[j] - buffer[j + tau];
      sum += delta * delta;
    }
    diff[tau] = sum;
  }
  return diff;
}

// 3. Cumulative mean normalized difference
function cumulativeMeanNormalizedDifference(diff, maxShift) {
  const cmnd = new Float32Array(maxShift);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < maxShift; tau++) {
    runningSum += diff[tau];
    cmnd[tau] = diff[tau] / (runningSum / tau);
  }
  return cmnd;
}

// 4. Absolute thresholding to find period
function absoluteThreshold(cmnd, maxShift, threshold) {
  let tau = -1;
  // Find local minimum below threshold
  for (let t = 2; t < maxShift; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 < maxShift && cmnd[t + 1] < cmnd[t]) {
        t++;
      }
      return t;
    }
  }
  // Fallback to global minimum if nothing is below threshold
  let minVal = 1e9;
  let minTau = -1;
  for (let t = 2; t < maxShift; t++) {
    if (cmnd[t] < minVal) {
      minVal = cmnd[t];
      minTau = t;
    }
  }
  return minTau;
}

// 5. Parabolic interpolation for sub-pixel precision
function parabolicInterpolation(cmnd, tau, maxShift) {
  if (tau <= 0 || tau >= maxShift - 1) return tau;
  const alpha = cmnd[tau - 1];
  const beta = cmnd[tau];
  const gamma = cmnd[tau + 1];
  const denom = alpha - 2 * beta + gamma;
  if (Math.abs(denom) < 1e-5) return tau;
  return tau + 0.5 * (alpha - gamma) / denom;
}

// YIN pitch estimation for a single frame
function estimatePitchYin(frame, sampleRate) {
  const windowSize = WINDOW_SIZE;
  const maxShift = Math.floor(sampleRate / MIN_FREQ);
  
  if (frame.length < windowSize + maxShift) return 0;
  
  // RMS Volume Gate
  let sumSquare = 0;
  for (let i = 0; i < windowSize; i++) {
    sumSquare += frame[i] * frame[i];
  }
  const rms = Math.sqrt(sumSquare / windowSize);
  if (rms < 0.004) return 0; // -48dB Gate

  const diff = yinDifference(frame, windowSize, maxShift);
  const cmnd = cumulativeMeanNormalizedDifference(diff, maxShift);
  const tau = absoluteThreshold(cmnd, maxShift, YIN_THRESHOLD);
  
  if (tau !== -1) {
    const interpolatedTau = parabolicInterpolation(cmnd, tau, maxShift);
    const freq = sampleRate / interpolatedTau;
    if (freq >= MIN_FREQ && freq <= MAX_FREQ) {
      // Convert frequency to MIDI pitch
      return 69 + 12 * Math.log2(freq / 440);
    }
  }
  return 0;
}

// Helper to filter and correct contours
function applyMedianFilter(contour) {
  const result = [...contour];
  const size = result.length;
  for (let i = 2; i < size - 2; i++) {
    if (result[i] === 0) continue;
    const window = [result[i-2], result[i-1], result[i], result[i+1], result[i+2]].filter(v => v > 0);
    if (window.length > 0) {
      window.sort((a, b) => a - b);
      result[i] = window[Math.floor(window.length / 2)];
    }
  }
  return result;
}

function applyOctaveCorrection(contour) {
  const result = [...contour];
  for (let i = 1; i < result.length - 1; i++) {
    if (result[i] === 0 || result[i - 1] === 0) continue;
    const diff = result[i] - result[i - 1];
    // Check if difference is around 12 semitones
    if (Math.abs(Math.abs(diff) - 12) < 1.5) {
      // Check if it's transient (returns back next frame)
      const nextDiff = result[i + 1] - result[i];
      if (Math.abs(nextDiff + diff) < 1.5) {
        result[i] = result[i - 1]; // Pull back to previous
      }
    }
  }
  return result;
}

// Slice the contour
function extractPitchContour(pcm, sampleRate) {
  const contour = [];
  const frameLength = WINDOW_SIZE;
  const maxShift = Math.floor(sampleRate / MIN_FREQ);
  const requiredLength = frameLength + maxShift;
  
  for (let offset = 0; offset + requiredLength <= pcm.length; offset += HOP_SIZE) {
    const frame = pcm.subarray(offset, offset + requiredLength);
    const pitch = estimatePitchYin(frame, sampleRate);
    contour.push(pitch);
  }
  
  // Post-processing DSP filters
  let filtered = applyMedianFilter(contour);
  filtered = applyOctaveCorrection(filtered);
  return filtered;
}

// Real-time analysis state
let realtimeBuffer = new Float32Array(0);
let lastValidMidi = 0;

// Web Worker message listener
self.onmessage = function (e) {
  const { type } = e.data;
  console.log('[Worker] Received message:', type);
  
  if (type === 'decode_pcm') {
    try {
      const { pcmBuffer, sampleRate } = e.data;
      let pcm = new Float32Array(pcmBuffer);
      
      // Resample to 16000Hz for standardized pitch tracking
      if (sampleRate !== SAMPLE_RATE) {
        const originalPcm = pcm;
        pcm = resamplePCM(originalPcm, sampleRate, SAMPLE_RATE);
        originalPcm.fill(0); // scrub original
      }
      
      // Extract pitch contour
      const contour = extractPitchContour(pcm, SAMPLE_RATE);
      
      // Clean up PCM
      pcm.fill(0);
      
      // Send back using Transferable Objects
      const contourArray = new Float32Array(contour);
      self.postMessage({
        type: 'decode_complete',
        contour: contourArray,
        sampleRate: SAMPLE_RATE,
        hopSize: HOP_SIZE
      }, [contourArray.buffer]);
      
    } catch (err) {
      console.error('[Worker] Error during pitch tracking:', err);
      self.postMessage({ type: 'decode_error', error: err.message });
    }
  } 
  else if (type === 'start_recording') {
    realtimeBuffer = new Float32Array(0);
    lastValidMidi = 0;
    console.log('[Worker] Realtime buffer reset for recording.');
  }
  else if (type === 'analyze_frame') {
    try {
      const { pcmBuffer, sampleRate } = e.data;
      let chunk = new Float32Array(pcmBuffer);
      
      // 在 Worker 线程中将麦克风原生采样率（例如 44.1k/48k）重采样为 16000Hz 供 YIN 提取，最大兼容真机环境 (Worker Realtime Resample)
      if (sampleRate && sampleRate !== SAMPLE_RATE) {
        chunk = resamplePCM(chunk, sampleRate, SAMPLE_RATE);
      }
      
      // Append chunk to realtimeBuffer
      const newBuffer = new Float32Array(realtimeBuffer.length + chunk.length);
      newBuffer.set(realtimeBuffer, 0);
      newBuffer.set(chunk, realtimeBuffer.length);
      realtimeBuffer = newBuffer;
      
      const maxShift = Math.floor(SAMPLE_RATE / MIN_FREQ);
      const frameLen = WINDOW_SIZE + maxShift;
      
      // Process sliding frames
      while (realtimeBuffer.length >= frameLen) {
        const frame = realtimeBuffer.subarray(0, frameLen);
        let midi = estimatePitchYin(frame, SAMPLE_RATE);
        
        // 实时音高流直接输出以保证极佳的响应速度与音程跨度 (Direct pass-through for best latency and instrument response)
        if (midi > 0) {
          lastValidMidi = midi;
        }
        
        self.postMessage({ type: 'frame_pitch', midi });
        
        // Slide by HOP_SIZE
        realtimeBuffer = realtimeBuffer.slice(HOP_SIZE);
      }
    } catch (err) {
      console.error('[Worker] Realtime analysis error:', err);
    }
  }
};