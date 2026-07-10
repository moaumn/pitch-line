// workers/audioWorker/decoder.js

/**
 * 纯 JS RIFF-WAV 音频格式解码器
 * 解析 ArrayBuffer 二进制流，提取并标准化为 Float32Array PCM 数据。
 * 支持 8-bit、16-bit 整数、32-bit 整数及 32-bit 浮点数格式 WAV。
 */
function decode(arrayBuffer) {
  const dataView = new DataView(arrayBuffer);
  
  // 1. 验证 RIFF 头
  const riff = String.fromCharCode(
    dataView.getUint8(0), dataView.getUint8(1),
    dataView.getUint8(2), dataView.getUint8(3)
  );
  if (riff !== 'RIFF') {
    throw new Error('格式错误：非标准 RIFF 文件');
  }

  // 2. 验证 WAVE 格式标志
  const wave = String.fromCharCode(
    dataView.getUint8(8), dataView.getUint8(9),
    dataView.getUint8(10), dataView.getUint8(11)
  );
  if (wave !== 'WAVE') {
    throw new Error('格式错误：非 WAVE 音频文件');
  }

  let offset = 12;
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let pcmData = null;

  // 3. 循环遍历 Subchunks
  while (offset < arrayBuffer.byteLength) {
    // 防范越界保护
    if (offset + 8 > arrayBuffer.byteLength) break;

    const chunkId = String.fromCharCode(
      dataView.getUint8(offset), dataView.getUint8(offset + 1),
      dataView.getUint8(offset + 2), dataView.getUint8(offset + 3)
    );
    const chunkSize = dataView.getUint32(offset + 4, true);
    
    if (chunkId === 'fmt ') {
      // 头部 fmt 子区块解析
      audioFormat = dataView.getUint16(offset + 8, true);
      numChannels = dataView.getUint16(offset + 10, true);
      sampleRate = dataView.getUint32(offset + 12, true);
      bitsPerSample = dataView.getUint16(offset + 20, true);
      
      console.log(`[WavDecoder] fmt info: Format=${audioFormat}, Channels=${numChannels}, SampleRate=${sampleRate}, Bits=${bitsPerSample}`);
    } else if (chunkId === 'data') {
      // 音频数据区块解析
      const dataOffset = offset + 8;
      // 加固保护，数据区不可大于剩余 buffer 长度
      const dataLength = Math.min(chunkSize, arrayBuffer.byteLength - dataOffset);
      
      if (bitsPerSample === 16) {
        // 16-bit 整数 PCM，最为常见
        const sampleCount = Math.floor(dataLength / 2);
        pcmData = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          const val = dataView.getInt16(dataOffset + i * 2, true);
          pcmData[i] = val / 32768.0; // 归一化至 [-1.0, 1.0]
        }
      } else if (bitsPerSample === 32) {
        if (audioFormat === 3) {
          // 32-bit IEEE 浮点数 PCM
          const sampleCount = Math.floor(dataLength / 4);
          pcmData = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            pcmData[i] = dataView.getFloat32(dataOffset + i * 4, true);
          }
        } else {
          // 32-bit 整数 PCM
          const sampleCount = Math.floor(dataLength / 4);
          pcmData = new Float32Array(sampleCount);
          for (let i = 0; i < sampleCount; i++) {
            const val = dataView.getInt32(dataOffset + i * 4, true);
            pcmData[i] = val / 2147483648.0;
          }
        }
      } else if (bitsPerSample === 8) {
        // 8-bit 无符号整数 PCM
        const sampleCount = dataLength;
        pcmData = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
          const val = dataView.getUint8(dataOffset + i);
          pcmData[i] = (val - 128.0) / 128.0; // 8-bit以128为零点偏置
        }
      } else {
        throw new Error(`暂不支持的 bitsPerSample 采样精度: ${bitsPerSample}`);
      }
      
      console.log(`[WavDecoder] Successfully parsed ${pcmData.length} samples.`);
      break; // 提取完音频波形，退出区块扫描
    }
    
    // 指针平移
    offset += 8 + chunkSize;
  }

  if (!pcmData) {
    throw new Error('文件破损：未能在 WAVE 文件中检索到 data 音频数据块');
  }

  return {
    pcmData,
    sampleRate,
    numChannels
  };
}

module.exports = {
  decode
};
