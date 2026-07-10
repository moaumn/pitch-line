// workers/audioWorker/pitchfinder.js

/**
 * 频率转浮点 MIDI 编号 (保留音分偏差，如 60.15)
 */
function hzToMidi(hz) {
  if (!hz || hz < 16) return 0;
  return 12 * Math.log2(hz / 440.0) + 69;
}

/**
 * YIN 核心基频检测算法
 * 具有高精准度与低高低八度误判率。
 * @param {Float32Array} pcmData - 帧音频信号
 * @param {number} sampleRate - 采样率
 * @param {number} threshold - 绝对阈值，默认为 0.15
 */
function detectPitchYin(pcmData, sampleRate, threshold = 0.15) {
  // 定义广谱人声寻调范围基底 60Hz - 900Hz (兼容深沉男低音与高亢女高音/假音)
  const minFreq = 60;
  const maxFreq = 900;
  const maxPeriod = Math.floor(sampleRate / minFreq);
  const minPeriod = Math.floor(sampleRate / maxFreq);
  
  // 1. RMS 门限静音判定 (调低门限至约 -54dB，以兼容低能量清唱或细微弱音)
  let sumSquare = 0;
  for (let i = 0; i < pcmData.length; i++) {
    sumSquare += pcmData[i] * pcmData[i];
  }
  const rms = Math.sqrt(sumSquare / pcmData.length);
  if (rms < 0.002) {
    return 0; // 无声区，音高置 0
  }

  const yinBuffer = new Float32Array(maxPeriod);
  
  // YIN Step 1: 差分函数 (Difference function)
  const limitLen = pcmData.length - maxPeriod;
  for (let tau = 1; tau < maxPeriod; tau++) {
    let diff = 0;
    for (let i = 0; i < limitLen; i++) {
      const d = pcmData[i] - pcmData[i + tau];
      diff += d * d;
    }
    yinBuffer[tau] = diff;
  }
  
  // YIN Step 2: 累积平均归一化差分函数 (Cumulative mean normalized difference function)
  yinBuffer[0] = 1.0;
  let runningSum = 0;
  for (let tau = 1; tau < maxPeriod; tau++) {
    runningSum += yinBuffer[tau];
    yinBuffer[tau] = yinBuffer[tau] / (runningSum / tau);
  }
  
  // YIN Step 3: 绝对阈值判定 (Absolute thresholding)
  let tauFound = -1;
  for (let tau = minPeriod; tau < maxPeriod; tau++) {
    if (yinBuffer[tau] < threshold) {
      tauFound = tau;
      break;
    }
  }
  
  // 兜底：如果未跌破阈值，取音高范围内曲线全局最低点作为备选周期
  if (tauFound === -1) {
    let minVal = 9999.0;
    for (let tau = minPeriod; tau < maxPeriod; tau++) {
      if (yinBuffer[tau] < minVal) {
        minVal = yinBuffer[tau];
        tauFound = tau;
      }
    }
  }
  
  // YIN Step 4: 抛物线插值，精确计算亚样本级别周期 (Parabolic interpolation)
  let betterTau = tauFound;
  if (tauFound > 0 && tauFound < maxPeriod - 1) {
    const s0 = yinBuffer[tauFound - 1];
    const s1 = yinBuffer[tauFound];
    const s2 = yinBuffer[tauFound + 1];
    const denom = s2 - 2.0 * s1 + s0;
    if (denom !== 0) {
      betterTau = tauFound + (s2 - s0) / (2.0 * denom);
    }
  }
  
  const pitch = sampleRate / betterTau;
  // 滤除频响外噪点
  if (pitch >= minFreq && pitch <= maxFreq) {
    return pitch;
  }
  return 0;
}

/**
 * 基于 DTW (动态时间规整) 算法比对两条 MIDI 音高曲线的相似度
 * 允许用户跟唱时存在轻微的时间拉伸或时差错位。
 * @param {Float32Array|Array} targetMidi - 原唱 MIDI 序列
 * @param {Float32Array|Array} userMidi - 用户 MIDI 序列
 * @returns {number} 匹配分值 (0 - 100)
 */
function computeDTWScore(targetMidi, userMidi) {
  const N = targetMidi.length;
  const M = userMidi.length;
  
  if (N === 0 || M === 0) return 0;
  
  // 创建 DTW 二维网格矩阵
  const dtw = [];
  for (let i = 0; i <= N; i++) {
    dtw[i] = new Float32Array(M + 1);
    dtw[i].fill(999999.0); // 填充较大数值作为无穷大初始化
  }
  dtw[0][0] = 0;
  
  // 动态规划计算累积代价矩阵
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      const tVal = targetMidi[i - 1];
      const uVal = userMidi[j - 1];
      
      let cost = 0;
      if (tVal === 0 && uVal === 0) {
        cost = 0; // 双重无声对齐
      } else if (tVal === 0 || uVal === 0) {
        cost = 8.0; // 一声一静的惩罚性代价
      } else {
        cost = Math.abs(tVal - uVal); // MIDI 半音尺度直线音高偏差
      }
      
      dtw[i][j] = cost + Math.min(
        dtw[i - 1][j],     // 伴唱时间拉伸
        dtw[i][j - 1],     // 原曲时间拉伸
        dtw[i - 1][j - 1]  // 音高对齐
      );
    }
  }
  
  const distance = dtw[N][M];
  // 代价根据序列长度归一化
  const avgDistance = distance / Math.max(N, M);
  
  // 转换算法分值，1个半音偏差得80分左右，3个半音(小三度)或以上定为0分
  const score = Math.max(0, Math.min(100, Math.round((1.0 - avgDistance / 3.0) * 100)));
  return score;
}

module.exports = {
  detectPitchYin,
  computeDTWScore,
  hzToMidi
};
