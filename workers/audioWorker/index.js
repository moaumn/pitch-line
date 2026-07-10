// workers/audioWorker/index.js
const decoder = require('./decoder.js');
const pitchfinder = require('./pitchfinder.js');

// 全局静态音频 PCM 数据及基频数据缓存
let globalPCM = null;
let globalSampleRate = 16000;
let globalContour = null; // 全局原唱 MIDI 音高序列
let realtimeBuffer = new Float32Array(0); // 缓存实时录制 PCM 段以组装滑动窗口
let lastRealtimeValidMidi = 0; // 缓存实时清唱上一个有效音高以防跳音 (Realtime Octave Correction)

// 滑动窗口设置
const WINDOW_SIZE = 1024;
const HOP_SIZE = 512;

// 线性插值音频重采样器，用于降低采样率节约内存
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

// 中值滤波器 (Median Filter)：去除偶发的单帧尖峰毛刺 (FR-DSP-Median)
function applyMedianFilter(arr, windowSize = 5) {
  const len = arr.length;
  const result = new Array(len);
  const half = Math.floor(windowSize / 2);

  for (let i = 0; i < len; i++) {
    const window = [];
    for (let w = -half; w <= half; w++) {
      const idx = i + w;
      if (idx >= 0 && idx < len) {
        window.push(arr[idx]);
      }
    }
    // 排序并提取中位数
    window.sort((a, b) => a - b);
    result[i] = window[Math.floor(window.length / 2)];
  }
  return result;
}

// 八度跳变修正器 (Octave Correction)：平滑因谐波产生的 +/-12MIDI 跳跃错误 (FR-DSP-Octave)
function applyOctaveCorrection(arr) {
  const len = arr.length;
  const result = arr.slice();
  let lastValidMidi = 0;

  for (let i = 0; i < len; i++) {
    const current = result[i];
    if (current > 0) {
      if (lastValidMidi > 0) {
        const diff = Math.abs(current - lastValidMidi);
        const rem = diff % 12;
        // 允许 1.5 半音的浮动偏差
        const isOctaveJump = rem <= 1.5 || rem >= 10.5;

        if (isOctaveJump && diff >= 10) {
          // 检查此跳音是否为瞬态噪声（下一帧或下两帧是否立刻恢复到原本的正常轨）
          const next1 = (i + 1 < len) ? result[i + 1] : 0;
          const next2 = (i + 2 < len) ? result[i + 2] : 0;

          const returnsNormal1 = next1 > 0 && Math.abs(next1 - lastValidMidi) <= 2;
          const returnsNormal2 = next2 > 0 && Math.abs(next2 - lastValidMidi) <= 2;

          if (returnsNormal1 || returnsNormal2 || next1 === 0) {
            // 瞬态跳音误差，强行拉回上一有效音轨高度
            result[i] = lastValidMidi;
            continue;
          }
        }
      }
      lastValidMidi = result[i];
    }
  }
  return result;
}

// 音高基频序列提取工具 (包含 RMS 能量门限降噪 + DSP 数据平滑清洗)
function extractPitchContour(pcm, sampleRate) {
  const pitchContour = [];
  const rmsThreshold = 0.004; // 能量门限 -48dB，低于此强行判为静音区以净化尾音毛刺 (FR-DSP-RMS)

  // 1. 流式提取 + 能量滤波
  for (let offset = 0; offset + WINDOW_SIZE <= pcm.length; offset += HOP_SIZE) {
    const frame = pcm.subarray(offset, offset + WINDOW_SIZE);
    
    // 计算当前帧的 RMS 能量
    let sumSquare = 0;
    for (let i = 0; i < frame.length; i++) {
      sumSquare += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sumSquare / frame.length);

    if (rms < rmsThreshold) {
      pitchContour.push(0); // 能量低，强行归零（静音断开不连线）
    } else {
      const hz = pitchfinder.detectPitchYin(frame, sampleRate);
      const midi = pitchfinder.hzToMidi(hz);
      pitchContour.push(midi);
    }
  }

  // 2. 依次灌入中值滤波与八度跳音修正，洗净噪音
  const medianFiltered = applyMedianFilter(pitchContour, 5);
  const cleanedContour = applyOctaveCorrection(medianFiltered);

  return cleanedContour;
}

// 监听主线程消息
worker.onMessage(function (res) {
  console.log('[Worker] Received message:', res.type);

  switch (res.type) {


    case 'decode_mp3_pcm':
      try {
        // 1. 接收主线程 WebAudio 已经解码好的 PCM (添加移动端序列化防御，确保其为 Float32Array)
        let pcm = res.pcm;
        if (!(pcm instanceof Float32Array)) {
          console.warn('[Worker] res.pcm is not Float32Array, attempting reconstruction. Type:', typeof pcm);
          if (pcm && pcm.buffer) {
            pcm = new Float32Array(pcm.buffer);
          } else if (pcm && (typeof pcm === 'object' || Array.isArray(pcm))) {
            pcm = Float32Array.from(Object.values(pcm));
          } else {
            throw new Error('未接收到合法的 PCM 音频二进制数据');
          }
        }
        globalSampleRate = res.sampleRate;

        // 2. 提取全局音高曲线
        globalContour = extractPitchContour(pcm, globalSampleRate);
        console.log('[Worker] MP3 PCM parsing & pitch estimation finished. Contour size:', globalContour.length);

        // 关键自救（加固）：物理擦除洗白大容量 PCM，强制触发 GC
        if (pcm) {
          pcm.fill(0);
          pcm = null;
        }
        if (globalPCM) {
          globalPCM.fill(0);
          globalPCM = null;
        }

        // 转化成 Float32Array 数组并启用可转移对象（transferList）无损发送，避免内存复制
        const contourArray = new Float32Array(globalContour);
        worker.postMessage({
          type: 'decode_complete',
          contour: contourArray,
          sampleRate: globalSampleRate,
          hopSize: HOP_SIZE
        }, [contourArray.buffer]);
      } catch (err) {
        console.error('[Worker] MP3 PCM process failed:', err);
        worker.postMessage({
          type: 'decode_error',
          error: err.message
        });
      }
      break;

    case 'slice':
      // 提取影子跟读特定切片的参考音高线
      const { tStart, tEnd } = res;
      if (!globalContour) {
        worker.postMessage({ type: 'slice_error', error: 'Vocal contour not loaded' });
        break;
      }
      
      const startFrame = Math.floor((tStart * globalSampleRate) / HOP_SIZE);
      const endFrame = Math.floor((tEnd * globalSampleRate) / HOP_SIZE);
      const slicedContour = globalContour.slice(
        Math.max(0, startFrame),
        Math.min(globalContour.length, endFrame)
      );

      worker.postMessage({
        type: 'slice_complete',
        contour: Array.from(slicedContour),
        tStart,
        tEnd
      });
      break;

    case 'compare_user':
      // 用户录音打分比对
      try {
        if (!globalContour) {
          throw new Error('未加载原唱参考线');
        }
        
        // 1. 根据头部标记识别是标准 WAV 还是 16-bit Raw PCM 并提取数据
        let pcmData = null;
        let userSampleRate = 16000;

        const header = new Uint8Array(res.buffer, 0, Math.min(4, res.buffer.byteLength));
        const isWav = header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46; // "RIFF"

        if (isWav) {
          console.log('[Worker] User recording is WAV format, decoding...');
          const userWav = decoder.decode(res.buffer);
          pcmData = userWav.pcmData;
          userSampleRate = userWav.sampleRate;
          userWav.pcmData = null;
        } else {
          console.log('[Worker] User recording is Raw PCM format, parsing...');
          const intData = new Int16Array(res.buffer);
          pcmData = new Float32Array(intData.length);
          for (let i = 0; i < intData.length; i++) {
            pcmData[i] = intData[i] / 32768.0;
          }
        }

        // 2. 提取清唱音高曲线
        const userContour = extractPitchContour(pcmData, userSampleRate);
        
        // 关键自救（加固）：物理擦除并洗白录制的原始 PCM 二进制数组，防止打分对比时堆积内存 (Compare OOM Fix)
        if (pcmData) {
          pcmData.fill(0);
          pcmData = null;
        }
        
        // 3. 切片获取原唱对应时间轴的参考音高曲线
        const sFrame = Math.floor((res.tStart * globalSampleRate) / HOP_SIZE);
        const eFrame = Math.floor((res.tEnd * globalSampleRate) / HOP_SIZE);
        const targetContourSlice = globalContour.slice(
          Math.max(0, sFrame),
          Math.min(globalContour.length, eFrame)
        );

        // 4. 调用 DTW 时序对齐算法并打分
        const score = pitchfinder.computeDTWScore(targetContourSlice, userContour);
        console.log(`[Worker] Pitch alignment score: ${score}`);

        // 转化成 Float32Array 数组并启用可转移对象（transferList）无损发送，防止内存克隆开销
        const userContourArray = new Float32Array(userContour);
        const targetSliceArray = new Float32Array(targetContourSlice);
        worker.postMessage({
          type: 'compare_complete',
          score,
          userContour: userContourArray,
          targetSlice: targetSliceArray
        }, [userContourArray.buffer, targetSliceArray.buffer]);
      } catch (err) {
        console.error('[Worker] Pitch comparison failed:', err);
        worker.postMessage({
          type: 'compare_error',
          error: err.message
        });
      }
      break;

    case 'start_recording':
      realtimeBuffer = new Float32Array(0); // 清空滑窗，重置录音数据流
      lastRealtimeValidMidi = 0; // 重置实时音高缓存
      break;

    case 'analyze_frame':
      try {
        // res.buffer 为 16-bit 有符号整数 PCM 二进制 ArrayBuffer
        const intData = new Int16Array(res.buffer);
        const floatData = new Float32Array(intData.length);
        for (let i = 0; i < intData.length; i++) {
          floatData[i] = intData[i] / 32768.0;
        }

        // 拼接新旧采样数据实现滑动组包 (FR-BufferAssembler)
        const combined = new Float32Array(realtimeBuffer.length + floatData.length);
        combined.set(realtimeBuffer);
        combined.set(floatData, realtimeBuffer.length);
        realtimeBuffer = combined;

        // 只要数据达到 WINDOW_SIZE (1024采样)，就调用 YIN 提取，然后以 HOP_SIZE (512采样) 滑动窗口
        while (realtimeBuffer.length >= WINDOW_SIZE) {
          const frame = realtimeBuffer.subarray(0, WINDOW_SIZE);
          
          // 1. 实时 RMS 能量门限降噪 (防尾音毛刺)
          let sumSquare = 0;
          for (let i = 0; i < frame.length; i++) {
            sumSquare += frame[i] * frame[i];
          }
          const rms = Math.sqrt(sumSquare / frame.length);
          
          let midi = 0;
          if (rms >= 0.004) { // 高于 -48dB 的有效音量才进行音高分析
            const hz = pitchfinder.detectPitchYin(frame, 16000);
            let calculatedMidi = pitchfinder.hzToMidi(hz);
            
            // 2. 实时八度跳变校正 (流式 Octave Correction)
            if (calculatedMidi > 0) {
              if (lastRealtimeValidMidi > 0) {
                const diff = Math.abs(calculatedMidi - lastRealtimeValidMidi);
                const rem = diff % 12;
                const isOctaveJump = rem <= 1.5 || rem >= 10.5;
                if (isOctaveJump && diff >= 10) {
                  // 发生倍频/半频谐波跳跃，强行修正拉回上一个音准点
                  calculatedMidi = lastRealtimeValidMidi;
                }
              }
              lastRealtimeValidMidi = calculatedMidi;
              midi = calculatedMidi;
            }
          }

          worker.postMessage({
            type: 'frame_pitch',
            midi
          });

          // 切碎断开，防止 typed array 内存泄漏
          realtimeBuffer = new Float32Array(realtimeBuffer.subarray(HOP_SIZE));
        }
      } catch (err) {
        console.error('[Worker] Realtime frame pitch extraction failed:', err);
      }
      break;

    case 'clear_memory':
      console.log('[Worker] Force clearing PCM buffer cache.');
      if (globalPCM) {
        globalPCM.fill(0);
        globalPCM = null;
      }
      if (realtimeBuffer) {
        realtimeBuffer.fill(0);
        realtimeBuffer = new Float32Array(0);
      }
      globalContour = null;
      lastRealtimeValidMidi = 0;
      break;

    default:
      console.warn('[Worker] Unknown message type:', res.type);
  }
});

// MinMax 音频波形抽稀压缩器，压缩比可达 99.9% (FR-WaveformDecimator)
// 主要用于未来绘制绿色背景波形图时，将数百万个采样点直接抽稀为少数像素点，避免主线程常驻任何大体积原始音频数组
function getMinMaxWaveform(pcm, width = 300) {
  const step = Math.floor(pcm.length / width);
  const minMaxData = new Float32Array(width * 2); // 存储每个区间的 [min, max]
  for (let i = 0; i < width; i++) {
    const start = i * step;
    const end = Math.min(start + step, pcm.length);
    let min = 1.0;
    let max = -1.0;
    for (let j = start; j < end; j++) {
      const val = pcm[j];
      if (val < min) min = val;
      if (val > max) max = val;
    }
    minMaxData[i * 2] = min;
    minMaxData[i * 2 + 1] = max;
  }
  return minMaxData;
}
