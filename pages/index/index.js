// pages/index/index.js
const app = getApp();

Page({
  data: {
    pageStep: 1, // 当前步骤，1为上传选歌，2为练习工作舱
    userStatus: {
      isVIP: true, // 预留权限，测试阶段强制为 true 畅通无阻
      dailyTriesLeft: 99
    },
    activeMode: 'auto', // 'auto' | 'shadow'
    trackA: null, // 伴奏 { name, path, size, displaySize, duration, displayDuration }
    trackB: null, // 纯人声干声 { name, path, size, displaySize, duration, displayDuration }
    decoding: false,
    isAutoPlaying: false,
    isListening: false,
    isShadowRecording: false,
    shadowSegment: {
      start: 0,
      end: 0,
      duration: 0,
      displayStart: '00:00.0',
      displayEnd: '00:00.0',
      displayDuration: '0.0s'
    },
    userRecordPath: null,
    lastScore: null,
    yAxisNotes: [], // 动态计算的音名轴数据
    minMidi: 48,
    maxMidi: 72,
    isIOS: false
  },

  // 内部音频与录音上下文
  audioCtxA: null,
  audioCtxB: null,
  recorder: null,
  canvas: null,
  ctx: null,
  canvasWidth: 300,
  canvasHeight: 240,
  worker: null,

  // 影子跟读捕获参数
  shadowTouchStartTime: 0,
  audioPlayStartTime: 0,
  targetPoints: [],
  userPoints: [],

  onLoad() {
    // 检测平台
    const sysInfo = wx.getSystemInfoSync();
    this.setData({
      isIOS: sysInfo.platform === 'ios'
    });

    // 初始化音频/录音管理器
    this.initAudioContexts();
    this.initRecorder();

    // 初始化 Worker
    this.initWorker();

    // 全局监听内存警告 (ER-5.1)
    wx.onMemoryWarning((res) => {
      this.handleMemoryWarning(res.level);
    });
  },

  onUnload() {
    // 释放资源
    if (this.audioCtxA) this.audioCtxA.destroy();
    if (this.audioCtxB) this.audioCtxB.destroy();
    if (this.worker) this.worker.terminate();
  },

  // 初始化 Canvas 2D 绘图 (带有节点自动重试及就绪后自愈重绘机制)
  initCanvas() {
    const query = wx.createSelectorQuery().in(this);
    query.select('#pitchCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res[0] || !res[0].node || res[0].width === 0) {
          console.warn('[Main] Canvas not ready or width is 0, retrying in 100ms...');
          setTimeout(() => {
            this.initCanvas();
          }, 100);
          return;
        }
        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');

        const dpr = wx.getSystemInfoSync().pixelRatio;
        canvas.width = res[0].width * dpr;
        canvas.height = res[0].height * dpr;
        ctx.scale(dpr, dpr);

        this.canvas = canvas;
        this.ctx = ctx;
        this.canvasWidth = res[0].width;
        this.canvasHeight = res[0].height;

        this.drawCanvasGrid();

        // Canvas就绪后，如果有待绘制的点数缓存，立刻渲染
        if (this.targetPoints && this.targetPoints.length > 0) {
          this.drawPitchCurves(this.targetPoints, this.userPoints);
        }
      });
  },

  // 绘制 Canvas 背景网格
  drawCanvasGrid() {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
    ctx.lineWidth = 1;

    // 垂直网格线
    const gridCols = 10;
    const colWidth = this.canvasWidth / gridCols;
    for (let i = 1; i < gridCols; i++) {
      ctx.beginPath();
      ctx.moveTo(i * colWidth, 0);
      ctx.lineTo(i * colWidth, this.canvasHeight);
      ctx.stroke();
    }
  },

  // 初始化播放器 (包含高频估算时钟同步)
  initAudioContexts() {
    this.audioCtxA = wx.createInnerAudioContext();
    this.audioCtxA.onError((err) => {
      console.error('AudioContext A Error:', err);
    });
    this.audioCtxA.onTimeUpdate(() => {
      // 用于平滑估算高刷新率的音频滚动进度
      this.playbackStartAudioTime = this.audioCtxA.currentTime;
      this.playbackSyncTime = Date.now();
    });

    this.audioCtxB = wx.createInnerAudioContext();
    this.audioCtxB.onError((err) => {
      console.error('AudioContext B Error:', err);
    });
  },

  // 初始化录音管理器 (配置高频率分包实时流处理)
  initRecorder() {
    this.recorder = wx.getRecorderManager();

    // 监听实时分包录音帧事件
    this.recorder.onFrameRecorded((res) => {
      const frameBuffer = res.frameBuffer;
      if (this.worker && (this.data.isAutoPlaying || this.data.isShadowRecording)) {
        // 向 Worker 发送原始 PCM 二进制段，使用可转移对象转移 ownership
        this.worker.postMessage({
          type: 'analyze_frame',
          buffer: frameBuffer
        }, [frameBuffer]);
      }
    });

    this.recorder.onStop((res) => {
      console.log('Recorder stopped', res.tempFilePath);
      this.setData({
        userRecordPath: res.tempFilePath
      });
      // 停止平滑画布重刷循环
      this.isRendering = false;
      wx.showToast({
        title: '录音已生成',
        icon: 'success'
      });
    });

    this.recorder.onError((err) => {
      console.error('Recorder Error:', err);
      this.isRendering = false;
    });
  },

  // 初始化 Worker
  initWorker() {
    if (wx.createWorker) {
      try {
        this.worker = wx.createWorker('workers/audioWorker/index.js');
        this.worker.onMessage((res) => {
          console.log('[Main] Worker message:', res.type);

          if (res.type === 'decode_complete') {
            this.setData({ decoding: false });
            wx.hideLoading(); // 显式清除全局 Loading
            wx.showToast({
              title: '音轨分析已完成',
              icon: 'success'
            });
            // 缓存全局参考曲线和采样率，用于平滑滚动渲染回路
            this.globalContour = Array.from(res.contour);
            this.globalSampleRate = res.sampleRate || 16000;
            // 动态调节 Y 轴并初始化/绘制音轨参考线
            this.calculateDynamicPitchRange(this.globalContour);
          } 
          else if (res.type === 'decode_error') {
            this.setData({ decoding: false });
            wx.hideLoading(); // 显式清除全局 Loading
            wx.showModal({
              title: '分析失败',
              content: res.error || '解码出现故障，请尝试更换音频文件。',
              showCancel: false
            });
          }
          else if (res.type === 'slice_complete') {
            // 切片成功，直接绘制选中切片的原唱音高线作为视觉引导
            const targetPoints = this.generatePitchPoints(Array.from(res.contour));
            this.drawPitchCurves(targetPoints, null);
          }
          else if (res.type === 'compare_complete') {
            wx.hideLoading();
            this.setData({
              lastScore: res.score
            });

            // 获取原唱切片和用户声音的实际坐标点
            const targetPoints = this.generatePitchPoints(Array.from(res.targetSlice));
            const userPoints = this.generatePitchPoints(Array.from(res.userContour));

            // 绘制双轨对比线
            this.drawPitchCurves(targetPoints, userPoints);

            wx.showToast({
              title: `相似度得分: ${res.score}分`,
              icon: 'success'
            });
          }
          else if (res.type === 'compare_error') {
            wx.hideLoading();
            wx.showModal({
              title: '评分失败',
              content: res.error || '比对音高曲线时出错。',
              showCancel: false
            });
          }
          else if (res.type === 'frame_pitch') {
            // 接收到实时录音切片的基频，追加并驱动 Canvas 绿线延伸
            this.userContour.push(res.midi);
          }
        });
      } catch (err) {
        console.error('Failed to init worker:', err);
      }
    }
  },

  // 模式切换
  switchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    this.stopAllOperations();
    this.setData({
      activeMode: mode,
      lastScore: null,
      userRecordPath: null
    });

    // 重置画布并重新绘制
    setTimeout(() => {
      this.initCanvas();
    }, 100);
  },

  // 进入练习舱
  enterPractice() {
    if (!this.data.trackB) return;
    this.setData({
      pageStep: 2
    });
    // 等待DOM挂载完成
    setTimeout(() => {
      this.initCanvas();
    }, 200);
  },

  // 返回选歌页
  backToUpload() {
    this.stopAllOperations();
    this.setData({
      pageStep: 1,
      lastScore: null,
      userRecordPath: null
    });
  },

  // 预留的权限鉴权（测试阶段默认通过）
  checkFeaturePermission() {
    return true;
  },

  // === 音名及 MIDI 音高计算公式 ===

  // 频率转 MIDI 编号
  hzToMidi(hz) {
    if (!hz || hz <= 0) return null;
    return Math.round(12 * Math.log2(hz / 440) + 69);
  },

  // MIDI 编号转音名
  midiToNoteName(midi) {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const noteIndex = midi % 12;
    const octave = Math.floor(midi / 12) - 1;
    return `${noteNames[noteIndex]}${octave}`;
  },

  // 根据音频音高范围动态计算 Y 轴音名展示 (FR-YAxis)
  calculateDynamicPitchRange(contour) {
    let minMidi = 48; // 默认 C3
    let maxMidi = 72; // 默认 C5

    if (contour && contour.length > 0) {
      // 过滤静音 unvoiced 点
      const activeMidis = contour.filter(v => v > 0);
      if (activeMidis.length > 0) {
        if (activeMidis.length > 10) {
          // 采用 5% 到 95% 分位数裁剪以消除高低八度跳音或环境噪声对音域宽度的过度拉扯 (FR-Outliers)
          const sorted = activeMidis.slice().sort((a, b) => a - b);
          const p5 = Math.floor(sorted.length * 0.05);
          const p95 = Math.floor(sorted.length * 0.95);
          minMidi = Math.round(sorted[p5]);
          maxMidi = Math.round(sorted[p95]);
        } else {
          minMidi = Math.round(Math.min(...activeMidis));
          maxMidi = Math.round(Math.max(...activeMidis));
        }
      }
    }

    const axisData = this.generateYAxisNotes(minMidi, maxMidi);

    this.setData({
      minMidi: axisData.minMidi,
      maxMidi: axisData.maxMidi,
      yAxisNotes: axisData.notes
    });

    // 重新初始化画布与坐标轴
    setTimeout(() => {
      this.initCanvas();

      // 等待画布渲染就绪后绘制全局原唱参考红线
      setTimeout(() => {
        if (contour) {
          const targetPoints = this.generatePitchPoints(contour);
          this.drawPitchCurves(targetPoints, null);
        }
      }, 100);
    }, 150);
  },

  // 生成音阶轴节点数组
  generateYAxisNotes(minMidi, maxMidi) {
    // 扩展上下冗余度各 2 个半音，让曲线画在中间不贴边
    let startMidi = Math.max(0, minMidi - 2);
    let endMidi = Math.min(127, maxMidi + 2);

    // 保证至少有一个八度的跨度，免得只有两个音导致轴线过宽
    if (endMidi - startMidi < 12) {
      const center = Math.round((startMidi + endMidi) / 2);
      startMidi = center - 6;
      endMidi = center + 6;
    }

    const notes = [];
    const totalSemitones = endMidi - startMidi;

    // 根据跨度决定步长，防止字重叠 (针对24rpx大字体优化：跨度大于18时每3个音显示一个；大于10时每2个显示一个；否则逐一显示)
    const step = totalSemitones > 18 ? 3 : (totalSemitones > 10 ? 2 : 1);

    for (let midi = endMidi; midi >= startMidi; midi--) {
      // 保证 C 音名（如 C4, C3）优先显示出来
      const isC = (midi % 12 === 0);
      if (isC || (endMidi - midi) % step === 0) {
        notes.push({
          midi: midi,
          name: this.midiToNoteName(midi),
          // Y轴的纵向位置百分比从上到下（0% - 100%）
          yPercent: ((endMidi - midi) / totalSemitones) * 100
        });
      }
    }

    return {
      notes,
      minMidi: startMidi,
      maxMidi: endMidi
    };
  },

  // MIDI音高转 Canvas 的 Y 坐标 (防零除保护)
  midiToY(midiVal) {
    const { minMidi, maxMidi } = this.data;
    const totalRange = (maxMidi - minMidi) || 12;
    const ratio = (maxMidi - midiVal) / totalRange;
    return ratio * this.canvasHeight;
  },

  // 获取音频时长
  getAudioDuration(tempFilePath) {
    return new Promise((resolve) => {
      const tempCtx = wx.createInnerAudioContext();
      tempCtx.src = tempFilePath;
      let resolved = false;

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          tempCtx.destroy();
          resolve(0);
        }
      }, 1500);

      tempCtx.onCanplay(() => {
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            const duration = tempCtx.duration || 0;
            tempCtx.destroy();
            resolve(duration);
          }
        }, 150);
      });

      tempCtx.onError((err) => {
        if (!resolved) {
          resolved = true;
          tempCtx.destroy();
          resolve(0);
        }
      });
    });
  },

  // 导入轨道 A
  importTrackA() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: async (res) => {
        const file = res.tempFiles[0];
        wx.showLoading({ title: '检查伴奏轨...' });

        const ext = file.name.split('.').pop().toLowerCase();
        const validExts = ['mp3', 'wav', 'mp4', 'mov'];
        if (!validExts.includes(ext)) {
          wx.hideLoading();
          wx.showModal({
            title: '格式不支持',
            content: '伴奏轨支持 MP3/WAV/MP4/MOV。',
            showCancel: false
          });
          return;
        }

        const duration = await this.getAudioDuration(file.path);
        wx.hideLoading();

        const sizeInMB = file.size / (1024 * 1024);
        if (sizeInMB > 50 || duration > 600) {
          wx.showModal({
            title: '强制拦截 (熔断)',
            content: `文件过大(${sizeInMB.toFixed(1)}MB)或时长过长，已被拦截。`,
            showCancel: false
          });
          return;
        }

        this.saveTrackLocally(file.path, 'trackA', ext).then((savedPath) => {
          this.setData({
            trackA: {
              name: file.name,
              path: savedPath,
              size: file.size,
              displaySize: this.formatSize(file.size),
              duration: duration,
              displayDuration: this.formatDuration(duration)
            }
          });
          wx.showToast({ title: '伴奏轨导入成功', icon: 'success' });
        });
      }
    });
  },

  // 导入轨道 B
  importTrackB() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      success: async (res) => {
        const file = res.tempFiles[0];
        wx.showLoading({ title: '检查人声轨...' });

        const ext = file.name.split('.').pop().toLowerCase();
        const validExts = ['mp3', 'wav'];
        if (!validExts.includes(ext)) {
          wx.hideLoading();
          wx.showModal({
            title: '格式不支持',
            content: '纯人声仅支持 MP3/WAV 格式。',
            showCancel: false
          });
          return;
        }

        const duration = await this.getAudioDuration(file.path);
        wx.hideLoading();

        const sizeInMB = file.size / (1024 * 1024);
        if (sizeInMB > 15.0) {
          wx.showModal({
            title: '长度超限 (安全防御)',
            content: `为防止手机运行内存不足闪退，原唱人声轨道限制在 4MB 且 150秒 (2.5分钟) 以内。当前大小：${sizeInMB.toFixed(1)}MB，时长：${Math.floor(duration)}秒。建议选择剪辑好的短音频进行练习。`,
            showCancel: false
          });
          return;
        }

        this.saveTrackLocally(file.path, 'trackB', ext).then((savedPath) => {
          this.setData({
            trackB: {
              name: file.name,
              path: savedPath,
              size: file.size,
              displaySize: this.formatSize(file.size),
              duration: duration,
              displayDuration: this.formatDuration(duration)
            },
            decoding: true
          });

          // 显示全局模态 Loading，阻断用户交互，防止解码 CPU 满载时产生点击无响应的 lag 感
          wx.showLoading({
            title: '音频解码分析中...',
            mask: true
          });

          // 统一使用主线程 WebAudio 解码所有音频格式 (WAV/MP3)
          this.decodeAudioOnMainThread(savedPath);
        });
      }
    });
  },

  // 本地存储
  saveTrackLocally(tempPath, typeName, ext) {
    return new Promise((resolve) => {
      const fs = wx.getFileSystemManager();
      const targetPath = `${wx.env.USER_DATA_PATH}/${typeName}.${ext}`;

      try {
        fs.accessSync(targetPath);
        fs.unlinkSync(targetPath);
      } catch (e) { }

      fs.saveFile({
        tempFilePath: tempPath,
        filePath: targetPath,
        success: (res) => resolve(res.savedFilePath),
        fail: () => resolve(tempPath)
      });
    });
  },

  // 线性插值音频重采样器，用于降低采样率节约 60%+ 传输与计算内存占用 (FR-Resample)
  resamplePCM(oldPCM, oldSampleRate, newSampleRate) {
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
  },

  // 微信主线程 WebAudio 解码任意音频文件 (MP3/WAV) 并投递 PCM 数组给 Worker (FR-3.2 Fallback)
  decodeAudioOnMainThread(savedPath) {
    const fs = wx.getFileSystemManager();
    fs.readFile({
      filePath: savedPath,
      success: (res) => {
        try {
          // 关键安全修正：微信底层在部分 Android/iOS 真机上如果传入配置字典会造成 C++ 桥接崩溃闪退，因此必须空参调用安全初始化
          const audioCtx = wx.createWebAudioContext();
          audioCtx.decodeAudioData(res.data, (audioBuffer) => {
            const nativePcm = audioBuffer.getChannelData(0); // 提取单声道
            const nativeSampleRate = audioBuffer.sampleRate;

            console.log(`[Main] Audio decoded via WebAudio. Samples: ${nativePcm.length}, SR: ${nativeSampleRate}`);

            // 关键优化：在主线程使用 JS 线性插值重采样为 16000Hz (单声道)，大幅度降低传输和接收内存大小，防止 OOM (Main OOM Downsample)
            const targetSampleRate = 16000;
            let resampledPcm = this.resamplePCM(nativePcm, nativeSampleRate, targetSampleRate);

            console.log(`[Main] Resampled PCM. New Samples: ${resampledPcm.length}, SR: ${targetSampleRate}`);

            if (this.worker) {
              this.worker.postMessage({
                type: 'decode_mp3_pcm',
                pcm: resampledPcm,
                sampleRate: targetSampleRate
              }, [resampledPcm.buffer]);
            }

            // 关键自救：投递给 Worker 后，立刻置空释放主线程占用的庞大 PCM 数据和解码缓冲区
            resampledPcm = null;
            audioBuffer = null;
            try {
              audioCtx.close();
            } catch (e) {
              console.warn('[Main] Close WebAudio failed:', e);
            }

            // 强行启动微信垃圾回收机制，即刻清除解压产生的瞬时堆栈垃圾，防范 OOM 强杀 (Trigger WeChat Native GC)
            if (wx.triggerGC) {
              console.log('[Main] Forcing Garbage Collection (wx.triggerGC)');
              wx.triggerGC();
            }
          }, (err) => {
            console.error('[Main] WebAudio decode failed:', err);
            this.setData({ decoding: false });
            try { audioCtx.close(); } catch (e) { }
            wx.hideLoading();
            wx.showModal({
              title: '解码失败',
              content: '文件无法使用系统级 WebAudio 解码，请更换为标准的 MP3 或 WAV 音频。',
              showCancel: false
            });
          });
        } catch (e) {
          console.error('[Main] createWebAudioContext failed:', e);
          this.setData({ decoding: false });
          wx.hideLoading();
          wx.showModal({
            title: '不支持解码',
            content: '当前手机系统版本较低，不支持 WebAudio 接口，请转换文件为 WAV 格式再试。',
            showCancel: false
          });
        }
      },
      fail: (err) => {
        console.error('[Main] Read Audio failed:', err);
        this.setData({ decoding: false });
        wx.hideLoading();
      }
    });
  },

  // 释放及重置音频配置 (重置音频返回首屏上传)
  resetAllTracks() {
    this.stopAllOperations();

    // 清除本地缓存文件
    const fs = wx.getFileSystemManager();
    if (this.data.trackA) {
      try { fs.unlinkSync(this.data.trackA.path); } catch (e) { }
    }
    if (this.data.trackB) {
      try { fs.unlinkSync(this.data.trackB.path); } catch (e) { }
    }

    this.setData({
      trackA: null,
      trackB: null,
      yAxisNotes: [],
      lastScore: null,
      userRecordPath: null,
      shadowSegment: {
        start: 0,
        end: 0,
        duration: 0,
        displayStart: '00:00.0',
        displayEnd: '00:00.0',
        displayDuration: '0.0s'
      }
    });

    setTimeout(() => {
      this.initCanvas();
    }, 100);
  },




  // 自动对唱模式录音切换 (FR-2.0 / FR-3.0)
  toggleAutoMode() {
    if (!this.data.trackB) return;

    if (this.data.isAutoPlaying) {
      const elapsed = (Date.now() - this.autoRecordStartTime) / 1000;
      this.stopAllOperations();
      this.setData({ isAutoPlaying: false });

      // 延迟确保录音文件生成并写入完毕后触发评分
      setTimeout(() => {
        this.startComparisonAuto(elapsed);
      }, 250);
    } else {
      this.setData({
        isAutoPlaying: true,
        lastScore: null,
        userRecordPath: null
      });

      this.userContour = [];
      this.autoRecordStartTime = Date.now();

      // 平滑滚动时钟同步初始化
      this.playbackStartAudioTime = 0;
      this.playbackSyncTime = Date.now();

      if (this.data.trackA) {
        this.audioCtxA.src = this.data.trackA.path;
        this.audioCtxA.play();
      } else {
        this.audioCtxA.src = this.data.trackB.path;
        this.audioCtxA.play();
      }

      // 开启新录音时，发信通知 Worker 重置实时音频组包滑窗
      if (this.worker) {
        this.worker.postMessage({ type: 'start_recording' });
      }

      this.recorder.start({
        duration: (this.data.trackA || this.data.trackB).duration * 1000,
        sampleRate: 16000,
        numberOfChannels: 1,
        frameSize: 2, // 2KB 原始 PCM 分包大小 (~64ms 数据)
        format: 'pcm', // 录音输出 16位有符号整型原始 PCM 字节
        audioSource: 'voice_communication'
      });

      // 开启 Canvas 60fps 平滑滚动画面循环渲染 (FR-4.0)
      this.isRendering = true;
      this.startRenderLoop();
    }
  },

  // === 影子跟读模式手势 (FR-2.2) ===
  onTouchStart(e) {
    if (!this.data.trackB) return;

    this.stopAllOperations();
    this.isRendering = false;

    const playCtx = this.audioCtxA;
    const playPath = this.data.trackA ? this.data.trackA.path : this.data.trackB.path;

    playCtx.src = playPath;
    playCtx.play();

    this.shadowTouchStartTime = Date.now();
    this.audioPlayStartTime = playCtx.currentTime || 0;

    this.setData({
      isListening: true,
      lastScore: null
    });

    // 开启 Canvas 渲染循环 (监听状态下音轨滚动)
    this.isRendering = true;
    this.startRenderLoop();
  },

  onTouchEnd(e) {
    if (!this.data.isListening) return;

    const playCtx = this.audioCtxA;
    playCtx.pause();
    this.isRendering = false;

    const touchDuration = (Date.now() - this.shadowTouchStartTime) / 1000;
    const tStart = this.audioPlayStartTime;
    const tEnd = tStart + touchDuration;

    this.setData({
      isListening: false,
      shadowSegment: {
        start: tStart,
        end: tEnd,
        duration: touchDuration,
        displayStart: this.formatDuration(tStart, true),
        displayEnd: this.formatDuration(tEnd, true),
        displayDuration: `${touchDuration.toFixed(1)}s`
      },
      userRecordPath: null
    });

    if (this.worker) {
      this.worker.postMessage({
        type: 'slice',
        tStart: tStart,
        tEnd: tEnd
      });
    }

    // 延时刷新一帧静态的中心位置切片预览线
    setTimeout(() => {
      this.drawDynamicFrame();
    }, 50);
  },

  toggleShadowRecording() {
    if (this.data.isShadowRecording) {
      this.recorder.stop();
      this.setData({ isShadowRecording: false });
    } else {
      this.setData({
        isShadowRecording: true,
        userRecordPath: null
      });

      this.userContour = [];
      this.recordStartTime = Date.now();

      // 开启新录音时，发信通知 Worker 重置实时音频组包滑窗
      if (this.worker) {
        this.worker.postMessage({ type: 'start_recording' });
      }

      this.recorder.start({
        duration: this.data.shadowSegment.duration * 1000,
        sampleRate: 16000,
        numberOfChannels: 1,
        frameSize: 2, // 2KB 原始 PCM 分包大小 (~64ms 数据)
        format: 'pcm'
      });

      // 开启 Canvas 60fps 平滑滚动画面循环渲染 (FR-4.0)
      this.isRendering = true;
      this.startRenderLoop();
    }
  },

  playShadowUserVoice() {
    if (!this.data.userRecordPath) return;
    this.audioCtxB.src = this.data.userRecordPath;
    this.audioCtxB.play();
  },

  // 自动模式全音轨比对打分
  startComparisonAuto(elapsedDuration) {
    if (!this.data.userRecordPath) return;
    wx.showLoading({ title: '进行相似度分析...' });

    const fs = wx.getFileSystemManager();
    fs.readFile({
      filePath: this.data.userRecordPath,
      success: (res) => {
        if (this.worker) {
          this.worker.postMessage({
            type: 'compare_user',
            buffer: res.data,
            tStart: 0,
            tEnd: elapsedDuration
          }, [res.data]);
        }
      },
      fail: (err) => {
        console.error('Read auto user recording failed:', err);
        wx.hideLoading();
      }
    });
  },

  // 影子跟读段落比对打分
  startComparison() {
    if (!this.data.userRecordPath) return;
    wx.showLoading({ title: '进行相似度分析...' });

    const fs = wx.getFileSystemManager();
    fs.readFile({
      filePath: this.data.userRecordPath,
      success: (res) => {
        if (this.worker) {
          this.worker.postMessage({
            type: 'compare_user',
            buffer: res.data,
            tStart: this.data.shadowSegment.start,
            tEnd: this.data.shadowSegment.end
          }, [res.data]);
        }
      },
      fail: (err) => {
        console.error('Read shadow user recording failed:', err);
        wx.hideLoading();
        wx.showToast({ title: '读取录音失败', icon: 'none' });
      }
    });
  },

  drawPitchCurves(targetPoints, userPoints) {
    if (targetPoints) this.targetPoints = targetPoints;
    if (userPoints) this.userPoints = userPoints;

    const ctx = this.ctx;
    if (!ctx) {
      console.warn('[Main] Canvas context not ready yet to draw.');
      return;
    }

    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    this.drawCanvasGrid();

    const tPoints = this.targetPoints;
    const uPoints = this.userPoints;

    // 1. 绘制原唱 (红线，支持静音分段断线)
    if (tPoints && tPoints.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#ff3366';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(255, 51, 102, 0.4)';

      let drawing = false;
      for (let i = 0; i < tPoints.length; i++) {
        const p = tPoints[i];
        if (p.y === null) {
          if (drawing) {
            ctx.stroke();
            drawing = false;
          }
        } else {
          if (!drawing) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            drawing = true;
          } else {
            ctx.lineTo(p.x, p.y);
          }
        }
      }
      if (drawing) {
        ctx.stroke();
      }
      ctx.restore();
    }

    // 2. 绘制录音 (绿线，支持静音分段断线)
    if (uPoints && uPoints.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#00e676';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(0, 230, 118, 0.4)';

      let drawing = false;
      for (let i = 0; i < uPoints.length; i++) {
        const p = uPoints[i];
        if (p.y === null) {
          if (drawing) {
            ctx.stroke();
            drawing = false;
          }
        } else {
          if (!drawing) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            drawing = true;
          } else {
            ctx.lineTo(p.x, p.y);
          }
        }
      }
      if (drawing) {
        ctx.stroke();
      }
      ctx.restore();
    }
  },

  // 映射真实音高 MIDI Contour 为 Canvas 上具体坐标 (X为等分，Y为MIDI音轨)
  generatePitchPoints(contour) {
    const points = [];
    if (!contour || contour.length === 0) return points;
    const step = this.canvasWidth / (contour.length - 1);

    for (let i = 0; i < contour.length; i++) {
      const midiVal = contour[i];
      if (midiVal <= 0) {
        points.push({ x: i * step, y: null }); // 静音 unvoiced 区
      } else {
        points.push({ x: i * step, y: this.midiToY(midiVal) });
      }
    }
    return points;
  },

  stopAllOperations() {
    if (this.audioCtxA) this.audioCtxA.stop();
    if (this.audioCtxB) this.audioCtxB.stop();
    try { this.recorder.stop(); } catch (e) { }
    this.setData({
      isAutoPlaying: false,
      isListening: false,
      isShadowRecording: false
    });
  },

  handleMemoryWarning(level) {
    if (level >= 1) {
      this.stopAllOperations();
      if (this.worker) {
        this.worker.postMessage({ type: 'clear_memory' });
      }
      this.setData({
        userRecordPath: null,
        decoding: false
      });
      wx.showModal({
        title: '【系统自救】内存紧张',
        content: '系统已主动释放音轨占用以防止崩溃。请尝试清理后台进程后重新练习。',
        showCancel: false
      });
    }
  },

  formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  },

  formatDuration(seconds, showMs = false) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (showMs) {
      const ms = Math.floor((seconds % 1) * 10);
      return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms}`;
    }
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  },

  // === 60fps 平滑滚动核心渲染回路 (FR-4.0) ===

  startRenderLoop() {
    this.renderLoop = () => {
      if (this.isRendering) {
        this.drawDynamicFrame();
        if (this.canvas && this.canvas.requestAnimationFrame) {
          this.canvas.requestAnimationFrame(this.renderLoop);
        } else {
          // 降级使用定时器刷新
          setTimeout(this.renderLoop, 16);
        }
      }
    };
    // 启动帧渲染
    if (this.canvas && this.canvas.requestAnimationFrame) {
      this.canvas.requestAnimationFrame(this.renderLoop);
    } else {
      setTimeout(this.renderLoop, 16);
    }
  },

  // 获取平滑估算高刷新率的音频滚动进度时间 (FR-4.2)
  getSmoothAudioTime() {
    if (!this.audioCtxA) return 0;
    const elapsedSinceLastSync = (Date.now() - this.playbackSyncTime) / 1000;
    const estimatedTime = this.playbackStartAudioTime + elapsedSinceLastSync;
    const maxDur = this.data.trackB ? this.data.trackB.duration : estimatedTime;
    return Math.max(0, Math.min(estimatedTime, maxDur));
  },

  // 动态绘制帧 (X轴平滑偏移)
  drawDynamicFrame() {
    const ctx = this.ctx;
    if (!ctx) return;

    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);
    this.drawCanvasGrid();

    // 1. 确定当前时刻 t
    let t = 0;
    if (this.data.isAutoPlaying || this.data.isListening) {
      t = this.getSmoothAudioTime();
    } else if (this.data.isShadowRecording) {
      const elapsed = (Date.now() - this.recordStartTime) / 1000;
      t = this.data.shadowSegment.start + elapsed;
    } else {
      // 静态居中展示选定段落的起始点
      t = this.data.shadowSegment.start || 0;
    }

    // 2. 绘制 30% 位置处的刻度游标虚线
    const cursorX = this.canvasWidth * 0.3;
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cursorX, 0);
    ctx.lineTo(cursorX, this.canvasHeight);
    ctx.stroke();
    ctx.restore();

    // 3. 像素比例换算 (以 5 秒为一个横轴屏显视窗大小)
    const visibleDuration = 5;
    const pixelsPerSecond = this.canvasWidth / visibleDuration;

    // 4. 绘制原唱音高参考红线 (全局滚动)
    if (this.globalContour && this.globalContour.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#ff3366';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(255, 51, 102, 0.4)';

      let drawing = false;
      const sampleRate = this.globalSampleRate || 16000;
      const hopDuration = 512 / sampleRate; // 根据实际解析的采样率动态计算步长时长

      for (let i = 0; i < this.globalContour.length; i++) {
        const midiVal = this.globalContour[i];
        const ptTime = i * hopDuration;

        // 影子跟读模式下，如果超出当前切片选区边界，则不予绘制该范围外的原唱参考线
        if (this.data.activeMode === 'shadow' && (ptTime < this.data.shadowSegment.start || ptTime > this.data.shadowSegment.end)) {
          if (drawing) {
            ctx.stroke();
            drawing = false;
          }
          continue;
        }

        // 时差相对游标映射为 X 像素位置
        const x = cursorX + (ptTime - t) * pixelsPerSecond;

        // 超出视窗左右边界的不予绘制
        if (x < -10 || x > this.canvasWidth + 10) {
          if (drawing) {
            ctx.stroke();
            drawing = false;
          }
          continue;
        }

        if (midiVal <= 0) {
          if (drawing) {
            ctx.stroke();
            drawing = false;
          }
        } else {
          const y = this.midiToY(midiVal);
          if (!drawing) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            drawing = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      if (drawing) {
        ctx.stroke();
      }
      ctx.restore();
    }

    // 5. 绘制用户录音音高绿线 (实时流式生成)
    if (this.userContour && this.userContour.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#00e676';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowBlur = 6;
      ctx.shadowColor = 'rgba(0, 230, 118, 0.4)';

      let drawing = false;
      const frameDuration = 0.064; // ~64ms 每帧

      // 录音起始参考点
      const recordStartOffset = (this.data.activeMode === 'auto') ? 0 : this.data.shadowSegment.start;

      for (let j = 0; j < this.userContour.length; j++) {
        const midiVal = this.userContour[j];
        const ptTime = recordStartOffset + (j * frameDuration);

        // 时差相对游标映射为 X 像素位置
        const x = cursorX + (ptTime - t) * pixelsPerSecond;

        if (x < -10 || x > this.canvasWidth + 10) {
          if (drawing) {
            ctx.stroke();
            drawing = false;
          }
          continue;
        }

        if (midiVal <= 0) {
          if (drawing) {
            ctx.stroke();
            drawing = false;
          }
        } else {
          const y = this.midiToY(midiVal);
          if (!drawing) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            drawing = true;
          } else {
            ctx.lineTo(x, y);
          }
        }
      }
      if (drawing) {
        ctx.stroke();
      }
      ctx.restore();
    }
  }
});
