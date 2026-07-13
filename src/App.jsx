import React, { useState, useEffect, useRef } from 'react';
import WaveSurfer from 'wavesurfer.js';

export default function App() {
  const [step, setStep] = useState(1);
  const [trackA, setTrackA] = useState(null);
  const [trackB, setTrackB] = useState(null);
  const [loadingText, setLoadingText] = useState(null);

  const [playing, setPlaying] = useState(false);
  const [recording, setRecording] = useState(false);
  const [score, setScore] = useState(null);

  // Dual training modes
  const [trainingMode, setTrainingMode] = useState('auto'); // 'auto' | 'shadow'
  const [shadowState, setShadowState] = useState('idle'); // 'idle' | 'listening' | 'following' | 'replaying' | 'countdown'
  const [shadowScore, setShadowScore] = useState(null);
  const [shadowRecording, setShadowRecording] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [toastScore, setToastScore] = useState(null);
  const [vocalEnabled, setVocalEnabled] = useState(true); // 是否开启原声音轨 (Vocal Guide Toggle)
  const [isDetectionOnly, setIsDetectionOnly] = useState(false); // 纯音高检测模式 (No audio file loaded)

  // 录音回放与合成导出状态 (Vocal playback and synthesis states)
  const [hasAutoRecording, setHasAutoRecording] = useState(false);
  const [hasShadowRecording, setHasShadowRecording] = useState(false);
  const [isReplayingRecording, setIsReplayingRecording] = useState(false);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const autoVocalBlobRef = useRef(null);
  const lastShadowVocalBlobRef = useRef(null);
  const shadowSegmentsRef = useRef([]); // 存储跟读模式下的所有历史录音分段
  const activePlaybackAudioRef = useRef(null);
  const decodedAccompanimentBufferRef = useRef(null);
  const practiceDurationRef = useRef(0);

  const isDetectionOnlyRef = useRef(false);
  const detectionStartMsRef = useRef(0);
  const recordingRef = useRef(false);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  const shadowTimerRef = useRef(null);
  const countdownIntervalRef = useRef(null);
  const toastTimerRef = useRef(null);
  const segmentStartRef = useRef(0);
  const segmentEndRef = useRef(0);
  const shadowFrameCountRef = useRef(0);
  const replayTimerRef = useRef(null);
  const savedContourRef = useRef(null);       // 重试前保存的用户音高数据，用于取消恢复
  const shadowStateRef = useRef('idle');       // 给 drawFrame 用的影子状态 ref，避免闭包过期
  const followStartMsRef = useRef(0);          // 跟唱开始的时间戳，用于虚拟播放头

  const wavesurferRef = useRef(null);
  const vocalAudioRef = useRef(null);  // 独立的人声 Audio 元素，用于跟读模式同步播放 Track A
  const workerRef = useRef(null);
  const canvasRef = useRef(null);
  const audioContextRef = useRef(null);
  const micStreamRef = useRef(null);
  const processorRef = useRef(null);
  const renderLoopIdRef = useRef(null);

  const globalContourRef = useRef([]);
  const userContourRef = useRef([]);
  const [pitchRange, setPitchRange] = useState({ min: 48, max: 84 });
  const pitchRangeRef = useRef({ min: 48, max: 84 });
  const updatePitchRange = (range) => {
    setPitchRange(range);
    pitchRangeRef.current = range;
  };

  // 禁用页面右键菜单
  useEffect(() => {
    const block = (e) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  useEffect(() => {
    // 使用相对路径以兼容 GitHub Pages 等子目录托管环境 (Use relative path to resolve worker in subfolders)
    workerRef.current = new Worker('worker.js');

    workerRef.current.onmessage = (e) => {
      const { type } = e.data;
      console.log('[Main] Worker message:', type);

      if (type === 'decode_complete') {
        const contour = Array.from(new Float32Array(e.data.contour));
        globalContourRef.current = contour;

        const validPitches = contour.filter(p => p > 0);
        if (validPitches.length > 0) {
          const min = Math.max(36, Math.floor(Math.min(...validPitches) - 3));
          const max = Math.min(96, Math.ceil(Math.max(...validPitches) + 3));
          updatePitchRange({ min, max });
        }

        setLoadingText(null);
        setStep(2);
      }
      else if (type === 'decode_error') {
        setLoadingText(null);
        alert('解析参考音高失败: ' + (e.data.error || '未知错误'));
      }
      else if (type === 'frame_pitch') {
        const { midi } = e.data;
        if (midi > 0) {
          const currentRange = pitchRangeRef.current;
          if (midi < currentRange.min) {
            updatePitchRange({ min: Math.max(12, Math.floor(midi) - 3), max: currentRange.max });
          } else if (midi > currentRange.max) {
            updatePitchRange({ min: currentRange.min, max: Math.min(127, Math.ceil(midi) + 3) });
          }
        }
        if (recording && isDetectionOnlyRef.current) {
          // 纯音高检测模式：根据运行时间对齐，直接写入用户曲线
          const currentTime = (performance.now() - detectionStartMsRef.current) / 1000;
          const frameIndex = Math.floor(currentTime * (16000 / 512));
          if (frameIndex >= 0 && frameIndex < userContourRef.current.length) {
            userContourRef.current[frameIndex] = midi;
          }
        } else if (wavesurferRef.current) {
          if (recording && playing) {
            // 自动模式：根据伴奏时间对齐，且仅在播放未暂停时写入
            const currentTime = wavesurferRef.current.getCurrentTime();
            const frameIndex = Math.floor(currentTime * (16000 / 512));
            userContourRef.current[frameIndex] = midi;
          } else if (shadowRecording) {
            // 跟读模式：根据本段起始时间点加上已收到帧数对齐
            const startFrame = Math.floor(segmentStartRef.current * (16000 / 512));
            const frameIndex = startFrame + shadowFrameCountRef.current;
            if (frameIndex < userContourRef.current.length) {
              userContourRef.current[frameIndex] = midi;
            }
            shadowFrameCountRef.current++;
          }
        }
      }
    };

    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
      }
    };
  }, [recording, shadowRecording, playing]);

  const isScrubbingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartTimeRef = useRef(0);
  const scrubbedTimeRef = useRef(0);

  const handleCanvasDragStart = (clientX) => {
    if (!wavesurferRef.current || isDetectionOnlyRef.current) return;
    isScrubbingRef.current = true;
    dragStartXRef.current = clientX;
    dragStartTimeRef.current = wavesurferRef.current.getCurrentTime();
    scrubbedTimeRef.current = dragStartTimeRef.current;
  };

  const handleCanvasDragMove = (clientX) => {
    if (!isScrubbingRef.current || !wavesurferRef.current) return;
    const deltaX = clientX - dragStartXRef.current;
    const SECONDS_PER_PIXEL = 0.032 / 5; // 1px = 6.4ms
    let newTime = dragStartTimeRef.current - deltaX * SECONDS_PER_PIXEL;
    const duration = wavesurferRef.current.getDuration();
    newTime = Math.max(0, Math.min(newTime, duration));
    scrubbedTimeRef.current = newTime;
  };

  const handleCanvasDragEnd = () => {
    if (isScrubbingRef.current && wavesurferRef.current) {
      wavesurferRef.current.setTime(scrubbedTimeRef.current);
    }
    isScrubbingRef.current = false;
  };

  const handleWaveformDragStart = (clientX, target) => {
    if (!wavesurferRef.current) return;
    const rect = target.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const pct = Math.max(0, Math.min(offsetX / rect.width, 1));
    const duration = wavesurferRef.current.getDuration();
    
    isScrubbingRef.current = true;
    scrubbedTimeRef.current = pct * duration;
  };

  const handleWaveformDragMove = (clientX, target) => {
    if (!isScrubbingRef.current || !wavesurferRef.current) return;
    const rect = target.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const pct = Math.max(0, Math.min(offsetX / rect.width, 1));
    const duration = wavesurferRef.current.getDuration();
    
    scrubbedTimeRef.current = pct * duration;
  };

  const handleCanvasMouseDown = (e) => {
    handleCanvasDragStart(e.clientX);
  };

  const handleCanvasMouseMove = (e) => {
    handleCanvasDragMove(e.clientX);
  };

  const handleCanvasMouseUp = () => {
    handleCanvasDragEnd();
  };

  const handleCanvasTouchStart = (e) => {
    if (e.touches.length > 0) {
      handleCanvasDragStart(e.touches[0].clientX);
    }
  };

  const handleCanvasTouchMove = (e) => {
    if (e.touches.length > 0) {
      handleCanvasDragMove(e.touches[0].clientX);
    }
  };

  const handleCanvasTouchEnd = () => {
    handleCanvasDragEnd();
  };

  const handleStartDetection = () => {
    isDetectionOnlyRef.current = true;
    setIsDetectionOnly(true);
    userContourRef.current = new Array(50000).fill(0);
    globalContourRef.current = [];
    updatePitchRange({ min: 48, max: 84 });
    setStep(2);
  };

  const handleStartAnalysis = async () => {
    if (!trackA) return;
    setLoadingText('正在读取并解码原唱干声音频...');

    try {
      const fileReader = new FileReader();
      fileReader.onload = async (e) => {
        try {
          const arrayBuffer = e.target.result;
          const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

          setLoadingText('WebAudio 正在对原声音频进行系统级解码...');
          const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

          setLoadingText('重构并压缩音频字节发送至 Worker 分析...');
          const channelData = audioBuffer.getChannelData(0);

          const rawBuffer = channelData.buffer.slice(0);
          workerRef.current.postMessage({
            type: 'decode_pcm',
            pcmBuffer: rawBuffer,
            sampleRate: audioBuffer.sampleRate
          }, [rawBuffer]);

          audioCtx.close();
        } catch (err) {
          console.error(err);
          setLoadingText(null);
          alert('解码音频失败，请确保格式正确。');
        }
      };
      fileReader.readAsArrayBuffer(trackA);
    } catch (err) {
      console.error(err);
      setLoadingText(null);
      alert('读取音频文件失败。');
    }
  };

  useEffect(() => {
    if (step === 2 && !isDetectionOnly) {
      wavesurferRef.current = WaveSurfer.create({
        container: '#waveform',
        waveColor: '#4f46e5',
        progressColor: '#a855f7',
        cursorColor: '#c084fc',
        barWidth: 2,
        barRadius: 2,
        height: 28,
        normalize: true,
        interact: false
      });

      // 伴奏可选：若用户未上传伴奏，加载原唱干声作为放音与同步基准
      const audioFile = trackB || trackA;
      wavesurferRef.current.load(URL.createObjectURL(audioFile));

      // 异步解码完整伴奏供混合导出使用
      const bufferReader = new FileReader();
      bufferReader.onload = async (event) => {
        try {
          const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
          decodedAccompanimentBufferRef.current = await offlineCtx.decodeAudioData(event.target.result);
          console.log('[Main] Accompaniment decoded successfully for export.');
        } catch (err) {
          console.error('[Main] Failed to decode accompaniment for mix/export:', err);
        }
      };
      bufferReader.readAsArrayBuffer(audioFile);

      wavesurferRef.current.on('play', () => setPlaying(true));
      wavesurferRef.current.on('pause', () => setPlaying(false));
      wavesurferRef.current.on('finish', () => handleStopAll());

      // 当用户同时上传了伴奏和人声时，创建独立的人声 Audio 元素
      // 跟读模式需要同时播放人声 + 伴奏，wavesurfer 负责伴奏，vocalAudio 负责人声
      // 若只有人声没有伴奏，wavesurfer 本身就在播放人声，无需额外元素
      if (trackB && trackA) {
        const vocalUrl = URL.createObjectURL(trackA);
        vocalAudioRef.current = new Audio(vocalUrl);
        vocalAudioRef.current.preload = 'auto';
      } else {
        vocalAudioRef.current = null;
      }

      userContourRef.current = new Array(globalContourRef.current.length).fill(0);
      setScore(null);

      return () => {
        if (wavesurferRef.current) {
          wavesurferRef.current.destroy();
          wavesurferRef.current = null;
        }
        if (vocalAudioRef.current) {
          vocalAudioRef.current.pause();
          vocalAudioRef.current.src = '';
          vocalAudioRef.current = null;
        }
      };
    }
  }, [step, trackA, trackB, isDetectionOnly]);

  useEffect(() => {
    if (step === 2 && canvasRef.current) {
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');

      const resizeCanvas = () => {
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * window.devicePixelRatio;
        canvas.height = rect.height * window.devicePixelRatio;
        ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
      };

      resizeCanvas();

      const drawFrame = () => {
        const width = canvas.width / window.devicePixelRatio;
        const height = canvas.height / window.devicePixelRatio;

        ctx.clearRect(0, 0, width, height);

        const totalNotes = pitchRange.max - pitchRange.min;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;

        for (let note = pitchRange.min; note <= pitchRange.max; note++) {
          const y = height - ((note - pitchRange.min) / totalNotes) * height;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }

        // 跟读模式 following 状态、拖动状态或纯音高检测模式下，计算实时滚动位置
        let currentTime;
        if (isDetectionOnlyRef.current) {
          currentTime = recordingRef.current ? (performance.now() - detectionStartMsRef.current) / 1000 : 0;
        } else if (isScrubbingRef.current) {
          currentTime = scrubbedTimeRef.current;
        } else if (shadowStateRef.current === 'following') {
          const elapsed = (performance.now() - followStartMsRef.current) / 1000;
          currentTime = segmentStartRef.current + elapsed;
          currentTime = Math.min(currentTime, segmentEndRef.current);
        } else {
          currentTime = wavesurferRef.current ? wavesurferRef.current.getCurrentTime() : 0;
        }
        const playheadFrame = currentTime * (16000 / 512);
        const cursorX = width / 3;
        const pxPerFrame = 5;

        const getCoords = (frameIndex, midiVal) => {
          const x = cursorX + (frameIndex - playheadFrame) * pxPerFrame;
          const y = height - ((midiVal - pitchRange.min) / totalNotes) * height;
          return { x, y };
        };

        const drawCurve = (contour, color, strokeWidth, isGlow) => {
          let inStroke = false;

          if (isGlow) {
            ctx.shadowBlur = 10;
            ctx.shadowColor = color;
          } else {
            ctx.shadowBlur = 0;
          }

          ctx.strokeStyle = color;
          ctx.lineWidth = strokeWidth;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          for (let i = 0; i < contour.length; i++) {
            const pitch = contour[i];
            if (pitch > 0) {
              const { x, y } = getCoords(i, pitch);
              if (x < -20 || x > width + 20) {
                if (inStroke) {
                  ctx.stroke();
                  inStroke = false;
                }
                continue;
              }

              if (!inStroke) {
                ctx.beginPath();
                ctx.moveTo(x, y);
                inStroke = true;
              } else {
                ctx.lineTo(x, y);
              }
            } else {
              if (inStroke) {
                ctx.stroke();
                inStroke = false;
              }
            }
          }
          if (inStroke) ctx.stroke();
        };

        if (!isDetectionOnlyRef.current) {
          drawCurve(globalContourRef.current, '#f59e0b', 3, true);
        }
        drawCurve(userContourRef.current, '#10b981', 3, false);

        // 实时在屏幕播放竖线位置显示当前音高 (Draw current pitch label at the vertical playhead line)
        const frameIdx = Math.floor(playheadFrame);
        const maxLen = isDetectionOnlyRef.current ? userContourRef.current.length : globalContourRef.current.length;
        if (frameIdx >= 0 && frameIdx < maxLen) {
          const targetMidi = isDetectionOnlyRef.current ? 0 : globalContourRef.current[frameIdx];
          const userMidi = userContourRef.current[frameIdx];

          ctx.save();
          ctx.font = 'bold 13px Outfit, -apple-system, sans-serif';

          // 在竖线左侧显示原唱参考音高 (Target Pitch on the left)
          if (targetMidi && targetMidi > 0) {
            const targetNote = midiToNoteName(targetMidi);
            const targetWidth = ctx.measureText(targetNote).width;

            // 半透明底色背景
            ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
            ctx.fillRect(cursorX - targetWidth - 10, 10, targetWidth + 6, 22);
            ctx.strokeStyle = 'rgba(245, 158, 11, 0.4)';
            ctx.lineWidth = 1;
            ctx.strokeRect(cursorX - targetWidth - 10, 10, targetWidth + 6, 22);

            ctx.fillStyle = '#f59e0b';
            ctx.fillText(targetNote, cursorX - targetWidth - 7, 26);
          }

          // 在竖线右侧显示用户实时音高 (User Sing Pitch on the right)
          if (userMidi && userMidi > 0) {
            const userNote = midiToNoteName(userMidi);
            const userWidth = ctx.measureText(userNote).width;

            // 半透明底色背景
            ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
            ctx.fillRect(cursorX + 4, 10, userWidth + 6, 22);
            ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
            ctx.lineWidth = 1;
            ctx.strokeRect(cursorX + 4, 10, userWidth + 6, 22);

            ctx.fillStyle = '#10b981';
            ctx.fillText(userNote, cursorX + 7, 26);
          }
          ctx.restore();
        }

        ctx.shadowBlur = 0;

        renderLoopIdRef.current = requestAnimationFrame(drawFrame);
      };

      renderLoopIdRef.current = requestAnimationFrame(drawFrame);

      return () => {
        cancelAnimationFrame(renderLoopIdRef.current);
      };
    }
  }, [step, pitchRange]);

  const handleStartRecording = async () => {
    if (!wavesurferRef.current) return;

    try {
      userContourRef.current = new Array(globalContourRef.current.length).fill(0);
      await ensureMicReady();

      // 初始化并开启 MediaRecorder 录制人声音频
      audioChunksRef.current = [];
      if (micStreamRef.current) {
        mediaRecorderRef.current = new MediaRecorder(micStreamRef.current);
        mediaRecorderRef.current.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            audioChunksRef.current.push(e.data);
          }
        };
        mediaRecorderRef.current.onstop = () => {
          const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          autoVocalBlobRef.current = blob;
          setHasAutoRecording(true);
        };
        mediaRecorderRef.current.start();
      }

      // 同步播放人声音轨
      if (vocalEnabled && vocalAudioRef.current) {
        vocalAudioRef.current.currentTime = 0;
        vocalAudioRef.current.play().catch(() => { });
      }
      wavesurferRef.current.play();
      setRecording(true);
      setScore(null);
    } catch (err) {
      console.error(err);
      alert('麦克风录音权限被拒绝或不可用。');
    }
  };

  const handleTogglePlayPause = () => {
    if (!wavesurferRef.current) return;

    if (playing) {
      wavesurferRef.current.pause();
      if (vocalAudioRef.current) {
        vocalAudioRef.current.pause();
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.pause();
      }
    } else {
      wavesurferRef.current.play();
      if (vocalEnabled && vocalAudioRef.current) {
        vocalAudioRef.current.currentTime = wavesurferRef.current.getCurrentTime();
        vocalAudioRef.current.play().catch(() => { });
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
        mediaRecorderRef.current.resume();
      }
    }
  };

  const handleToggleVocal = () => {
    const nextVal = !vocalEnabled;
    setVocalEnabled(nextVal);

    if (vocalAudioRef.current) {
      if (nextVal) {
        if (wavesurferRef.current && wavesurferRef.current.isPlaying()) {
          vocalAudioRef.current.currentTime = wavesurferRef.current.getCurrentTime();
          vocalAudioRef.current.play().catch(() => { });
        }
      } else {
        vocalAudioRef.current.pause();
      }
    }
  };

  // === Mic Lifecycle Helpers (shared by auto & shadow modes) ===
  const ensureMicReady = async () => {
    if (audioContextRef.current) return; // already running

    const constraints = {
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    micStreamRef.current = stream;
    workerRef.current.postMessage({ type: 'start_recording' });

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    audioContextRef.current = new AudioCtx();
    const nativeSampleRate = audioContextRef.current.sampleRate;

    const source = audioContextRef.current.createMediaStreamSource(stream);
    processorRef.current = audioContextRef.current.createScriptProcessor(2048, 1, 1);
    source.connect(processorRef.current);
    processorRef.current.connect(audioContextRef.current.destination);

    processorRef.current.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const floatData = new Float32Array(input);
      const buffer = floatData.buffer;
      if (workerRef.current) {
        workerRef.current.postMessage({
          type: 'analyze_frame',
          pcmBuffer: buffer,
          sampleRate: nativeSampleRate
        }, [buffer]);
      }
    };
  };

  const teardownMic = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
  };

  const handleStopAll = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (wavesurferRef.current) {
      practiceDurationRef.current = wavesurferRef.current.getCurrentTime();
      wavesurferRef.current.pause();
      wavesurferRef.current.setTime(0); // 进度归零 (Reset progress to zero)
    }
    if (vocalAudioRef.current) {
      vocalAudioRef.current.pause();
      vocalAudioRef.current.currentTime = 0;
    }

    // 清理跟唱与倒计时定时器 (Clean up all countdown and recording timers)
    if (shadowTimerRef.current) clearTimeout(shadowTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setCountdown(null);
    setToastScore(null);

    teardownMic();
    setRecording(false);
    setShadowRecording(false);
    shadowStateRef.current = 'idle';
    setShadowState('idle');
    if (!isDetectionOnlyRef.current) {
      calculateScore();
    }
  };

  // === Playback & Export Handlers ===
  const handleStartPlayback = () => {
    if (!wavesurferRef.current) return;
    
    let vocalBlob = null;
    let startOffset = 0;
    
    if (trainingMode === 'shadow') {
      vocalBlob = lastShadowVocalBlobRef.current;
      startOffset = segmentStartRef.current;
    } else {
      vocalBlob = autoVocalBlobRef.current;
      startOffset = 0;
    }

    if (!vocalBlob) {
      alert("暂无录音可供回放。");
      return;
    }

    handleStopPlayback();

    const url = URL.createObjectURL(vocalBlob);
    const audio = new Audio(url);
    activePlaybackAudioRef.current = audio;
    
    setIsReplayingRecording(true);

    if (trainingMode === 'shadow') {
      const duration = wavesurferRef.current.getDuration();
      wavesurferRef.current.seekTo(startOffset / duration);
      
      const onTimeUpdate = () => {
        if (!wavesurferRef.current) return;
        const time = wavesurferRef.current.getCurrentTime();
        if (time >= segmentEndRef.current - 0.05) {
          handleStopPlayback();
        }
      };

      wavesurferRef.current.on('timeupdate', onTimeUpdate);
      wavesurferRef.current.on('pause', () => audio.pause());
      wavesurferRef.current.on('play', () => audio.play().catch(()=>{}));
      
      activePlaybackAudioRef.current._cleanup = () => {
        if (wavesurferRef.current) {
          wavesurferRef.current.un('timeupdate', onTimeUpdate);
        }
      };
      
      audio.currentTime = 0;
      audio.play().catch(()=>{});
      wavesurferRef.current.play();
    } else {
      wavesurferRef.current.seekTo(0);

      const onTimeUpdate = () => {
        if (!wavesurferRef.current || !activePlaybackAudioRef.current) return;
        const wsTime = wavesurferRef.current.getCurrentTime();
        const diff = Math.abs(activePlaybackAudioRef.current.currentTime - wsTime);
        if (diff > 0.15) {
          activePlaybackAudioRef.current.currentTime = wsTime;
        }
      };

      wavesurferRef.current.on('timeupdate', onTimeUpdate);
      wavesurferRef.current.on('pause', () => audio.pause());
      wavesurferRef.current.on('play', () => audio.play().catch(()=>{}));

      activePlaybackAudioRef.current._cleanup = () => {
        if (wavesurferRef.current) {
          wavesurferRef.current.un('timeupdate', onTimeUpdate);
        }
      };

      audio.currentTime = 0;
      audio.play().catch(()=>{});
      wavesurferRef.current.play();
    }
  };

  const handleStopPlayback = () => {
    setIsReplayingRecording(false);
    
    if (activePlaybackAudioRef.current) {
      activePlaybackAudioRef.current.pause();
      if (activePlaybackAudioRef.current._cleanup) {
        activePlaybackAudioRef.current._cleanup();
      }
      activePlaybackAudioRef.current = null;
    }
    
    if (wavesurferRef.current) {
      wavesurferRef.current.pause();
      wavesurferRef.current.setTime(0);
    }
  };

  const exportMixedAudio = async (isConcatAll) => {
    setLoadingText("正在混合人声与伴奏，请稍候...");

    try {
      let duration = 0;
      let vocalsToMix = [];

      if (isConcatAll) {
        // 跟唱模式下，只导出至最远的已录制片段结束位置 (Only export up to the end of the furthest recorded segment)
        const maxEndTime = shadowSegmentsRef.current.reduce((max, seg) => Math.max(max, seg.end), 0);
        duration = maxEndTime > 0 ? maxEndTime : (decodedAccompanimentBufferRef.current ? decodedAccompanimentBufferRef.current.duration : 10);
        
        const offlineCtxForDecoding = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
        for (const seg of shadowSegmentsRef.current) {
          const vocalBuf = await decodeBlobToAudioBuffer(seg.blob, offlineCtxForDecoding);
          vocalsToMix.push({ start: seg.start, buffer: vocalBuf });
        }
      } else {
        if (!autoVocalBlobRef.current) {
          alert("暂无录音文件可供导出。");
          setLoadingText(null);
          return;
        }
        // 自动模式下，只导出至当初点击停止时的进度位置 (Only export up to the position where stop was clicked)
        duration = practiceDurationRef.current > 0 ? practiceDurationRef.current : wavesurferRef.current.getDuration();
        
        const offlineCtxForDecoding = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
        const vocalBuf = await decodeBlobToAudioBuffer(autoVocalBlobRef.current, offlineCtxForDecoding);
        vocalsToMix.push({ start: 0, buffer: vocalBuf });
      }

      // 降低采样率减小体积 (Mono 单声道 + 22050Hz 采样率，可实现近 4 倍的无损级别体积压缩)
      const exportSampleRate = 22050;
      const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
        1, 
        Math.floor(exportSampleRate * duration), 
        exportSampleRate
      );

      // 仅在存在分轨伴奏 trackB 且非原唱 trackA 时混入伴奏 (避免混入原唱干声中原有的歌手人声轨道)
      if (trackB && decodedAccompanimentBufferRef.current) {
        const accompSource = offlineCtx.createBufferSource();
        accompSource.buffer = decodedAccompanimentBufferRef.current;
        accompSource.connect(offlineCtx.destination);
        accompSource.start(0);
      }

      for (const item of vocalsToMix) {
        const vocalSource = offlineCtx.createBufferSource();
        vocalSource.buffer = item.buffer;
        vocalSource.connect(offlineCtx.destination);
        vocalSource.start(item.start);
      }

      const renderedBuffer = await offlineCtx.startRendering();
      const wavBlob = bufferToWav(renderedBuffer);

      const url = URL.createObjectURL(wavBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = isConcatAll ? "pitch_line_shadow_mix.wav" : "pitch_line_auto_mix.wav";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setLoadingText(null);
      alert("🎉 音频混合并导出成功！");
    } catch (err) {
      console.error(err);
      setLoadingText(null);
      alert("混合并导出音频失败：" + err.message);
    }
  };

  // === Shadow (跟读) Mode Handlers ===
  const handleShadowPressStart = async (e) => {
    if (e) e.preventDefault();
    if (!wavesurferRef.current) return;

    // 清理可能遗留的跟唱定时器与倒计时
    if (shadowTimerRef.current) clearTimeout(shadowTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    setCountdown(null);

    try {
      await ensureMicReady();
    } catch (err) {
      console.error(err);
      alert('麦克风权限被拒绝或不可用。');
      return;
    }

    // Mark the start of this listening segment
    segmentStartRef.current = wavesurferRef.current.getCurrentTime();
    setShadowRecording(false);   // not recording pitch while listening
    shadowStateRef.current = 'listening';
    setShadowState('listening');

    // 同步播放人声 + 伴奏
    if (vocalAudioRef.current) {
      vocalAudioRef.current.currentTime = segmentStartRef.current;
      vocalAudioRef.current.play().catch(() => { });
    }
    wavesurferRef.current.play();
  };

  const handleShadowPressEnd = (e) => {
    if (e) e.preventDefault();
    if (!wavesurferRef.current) return;

    wavesurferRef.current.pause();
    if (vocalAudioRef.current) {
      vocalAudioRef.current.pause();
    }
    segmentEndRef.current = wavesurferRef.current.getCurrentTime();

    // 松开按钮后，进入 2s 倒计时准备状态 (Trigger 2s countdown before following)
    startCountdown();
  };

  const startCountdown = () => {
    if (shadowTimerRef.current) clearTimeout(shadowTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);

    setShadowRecording(false);
    shadowStateRef.current = 'countdown';
    setShadowState('countdown');
    setCountdown(2);

    let count = 2;
    countdownIntervalRef.current = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
        setCountdown(null);
        startFollowing();
      } else {
        setCountdown(count);
      }
    }, 1000);
  };

  const startFollowing = async () => {
    try {
      await ensureMicReady();
    } catch (err) {
      console.error(err);
      alert('麦克风权限被拒绝。');
      shadowStateRef.current = 'idle';
      setShadowState('idle');
      return;
    }

    // 初始化并开启 MediaRecorder 录制当前跟读分段
    audioChunksRef.current = [];
    if (micStreamRef.current) {
      mediaRecorderRef.current = new MediaRecorder(micStreamRef.current);
      mediaRecorderRef.current.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };
      mediaRecorderRef.current.onstop = () => {
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        lastShadowVocalBlobRef.current = blob;

        const segment = {
          start: segmentStartRef.current,
          end: segmentEndRef.current,
          blob
        };

        // 覆盖重复或新增分段
        const idx = shadowSegmentsRef.current.findIndex(s => Math.abs(s.start - segment.start) < 0.1);
        if (idx >= 0) {
          shadowSegmentsRef.current[idx] = segment;
        } else {
          shadowSegmentsRef.current.push(segment);
        }
        setHasShadowRecording(true);
      };
      mediaRecorderRef.current.start();
    }

    shadowFrameCountRef.current = 0;
    followStartMsRef.current = performance.now();
    shadowStateRef.current = 'following';
    setShadowRecording(true);
    setShadowState('following');

    // 跟唱开始：倒播伴奏声轨开始播放以辅助唱歌，但不播放人声 (Play accompaniment only during singing)
    const duration = wavesurferRef.current.getDuration();
    if (duration > 0) {
      wavesurferRef.current.seekTo(segmentStartRef.current / duration);
      wavesurferRef.current.play();
    }

    // 自动结束跟唱：持续时间 = 录制段落时长，到期直接结束录音 (Stop recording immediately when segment duration is reached)
    const segmentDuration = segmentEndRef.current - segmentStartRef.current;
    const totalDurationSec = Math.max(0.5, segmentDuration);

    shadowTimerRef.current = setTimeout(() => {
      handleStopShadowRecording();
    }, totalDurationSec * 1000);
  };

  const handleShadowRetry = () => {
    if (!wavesurferRef.current) return;

    if (shadowTimerRef.current) clearTimeout(shadowTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    setCountdown(null);

    // 确定当前段落实际填充的最大帧数范围，进行精准保存与擦除
    const startFrame = Math.floor(segmentStartRef.current * (16000 / 512));
    const endFrame = Math.floor(segmentEndRef.current * (16000 / 512));
    const maxWrittenFrame = startFrame + shadowFrameCountRef.current;
    const clearEndFrame = Math.max(endFrame, maxWrittenFrame);

    // 保存当前段落用户音高数据，以便取消时恢复
    savedContourRef.current = {
      startFrame,
      clearEndFrame,
      data: userContourRef.current.slice(startFrame, clearEndFrame),
      wasRecording: shadowRecording,
      savedFrameCount: shadowFrameCountRef.current
    };

    // 停止当前录音并彻底擦除从段落起点到最大写入帧之间的所有用户音高数据（清除上次录音的画线）
    setShadowRecording(false);
    for (let i = startFrame; i < clearEndFrame && i < userContourRef.current.length; i++) {
      userContourRef.current[i] = 0;
    }
    shadowFrameCountRef.current = 0; // 重置已录制帧数

    // 回到段落起点并自动回放该段 (Both accompaniment and vocals played for user reference)
    const duration = wavesurferRef.current.getDuration();
    if (duration > 0) {
      wavesurferRef.current.seekTo(segmentStartRef.current / duration);
    }
    if (vocalAudioRef.current) {
      vocalAudioRef.current.currentTime = segmentStartRef.current;
      vocalAudioRef.current.play().catch(() => { });
    }
    shadowStateRef.current = 'replaying';
    setShadowState('replaying');
    wavesurferRef.current.play();
  };

  const handleCancelRetry = () => {
    if (!wavesurferRef.current) return;

    if (shadowTimerRef.current) clearTimeout(shadowTimerRef.current);
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    setCountdown(null);

    // 停止回放
    wavesurferRef.current.pause();
    if (vocalAudioRef.current) vocalAudioRef.current.pause();
    if (replayTimerRef.current) cancelAnimationFrame(replayTimerRef.current);

    // 恢复之前保存的用户音高数据
    if (savedContourRef.current) {
      const { startFrame, data, wasRecording, savedFrameCount } = savedContourRef.current;
      for (let i = 0; i < data.length; i++) {
        if (startFrame + i < userContourRef.current.length) {
          userContourRef.current[startFrame + i] = data[i];
        }
      }
      setShadowRecording(wasRecording);
      shadowFrameCountRef.current = savedFrameCount;
      savedContourRef.current = null;
    }

    // seek 回到段落结尾（重试前的位置）
    const duration = wavesurferRef.current.getDuration();
    if (duration > 0) {
      wavesurferRef.current.seekTo(segmentEndRef.current / duration);
    }
    if (vocalAudioRef.current) {
      vocalAudioRef.current.currentTime = segmentEndRef.current;
    }

    shadowStateRef.current = 'following';
    followStartMsRef.current = performance.now() - (segmentEndRef.current - segmentStartRef.current) * 1000;
    setShadowState('following');
  };

  // 当进入 replaying 状态时，轮询检测是否已播到段落终点，到达后自动切入倒计时与跟唱
  useEffect(() => {
    if (shadowState === 'replaying' && wavesurferRef.current) {
      const checkEnd = () => {
        if (!wavesurferRef.current) return;
        const t = wavesurferRef.current.getCurrentTime();
        if (t >= segmentEndRef.current - 0.05) {
          wavesurferRef.current.pause();
          if (vocalAudioRef.current) vocalAudioRef.current.pause();

          // 回放结束，进入倒计时
          startCountdown();
          return;
        }
        replayTimerRef.current = requestAnimationFrame(checkEnd);
      };
      replayTimerRef.current = requestAnimationFrame(checkEnd);
      return () => {
        if (replayTimerRef.current) cancelAnimationFrame(replayTimerRef.current);
      };
    }
  }, [shadowState]);

  const handleStopShadowRecording = () => {
    setShadowRecording(false);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }

    if (shadowTimerRef.current) {
      clearTimeout(shadowTimerRef.current);
      shadowTimerRef.current = null;
    }

    if (wavesurferRef.current) {
      wavesurferRef.current.pause();
      // 伴奏必须也暂停在用户当初松开按钮的那一刻 (Accomp paused exactly at segment release point)
      const duration = wavesurferRef.current.getDuration();
      if (duration > 0) {
        wavesurferRef.current.seekTo(segmentEndRef.current / duration);
      }
    }

    // 计算当前段落得分并触发轻弹窗显示 (Calculate segment score and trigger overlay toast)
    const target = globalContourRef.current;
    const user = userContourRef.current;
    const startFrame = Math.floor(segmentStartRef.current * (16000 / 512));
    const endFrame = Math.floor(segmentEndRef.current * (16000 / 512));

    let voicedFrames = 0;
    let correctFrames = 0;
    for (let i = startFrame; i < endFrame && i < target.length; i++) {
      if (target[i] > 0) {
        voicedFrames++;
        if (user[i] > 0) {
          const diff = Math.abs(user[i] - target[i]);
          if (diff <= 1.2) correctFrames += 1.0;
          else if (diff <= 2.2) correctFrames += 0.7;
          else if (diff <= 3.2) correctFrames += 0.3;
        }
      }
    }

    const calculated = voicedFrames > 0 ? Math.round((correctFrames / voicedFrames) * 100) : 0;

    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastScore(calculated);
    toastTimerRef.current = setTimeout(() => {
      setToastScore(null);
    }, 3000);

    // 录音跟唱结束，切入完成待机状态 (Transition to follow complete/done state)
    shadowStateRef.current = 'following_done';
    setShadowState('following_done');
  };

  const midiToNoteName = (midiVal) => {
    if (!midiVal || midiVal <= 0) return '';
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const noteIndex = Math.round(midiVal);
    const name = noteNames[noteIndex % 12];
    const octave = Math.floor(noteIndex / 12) - 1;
    return `${name}${octave}`;
  };

  const calculateScore = () => {
    const target = globalContourRef.current;
    const user = userContourRef.current;

    let voicedFrames = 0;
    let correctFrames = 0;

    for (let i = 0; i < target.length; i++) {
      if (target[i] > 0) {
        voicedFrames++;
        if (user[i] > 0) {
          const diff = Math.abs(user[i] - target[i]);
          if (diff <= 1.2) {
            correctFrames += 1.0;
          } else if (diff <= 2.2) {
            correctFrames += 0.7;
          } else if (diff <= 3.2) {
            correctFrames += 0.3;
          }
        }
      }
    }

    if (voicedFrames === 0) return;
    const rawScore = Math.round((correctFrames / voicedFrames) * 100);
    setScore(rawScore);

    // 自动播放结束或点击停止后，弹出得分轻提示几秒
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastScore(rawScore);
    toastTimerRef.current = setTimeout(() => {
      setToastScore(null);
    }, 3000);
  };

  const renderNoteLabels = () => {
    const notes = [];
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    for (let note = pitchRange.max; note >= pitchRange.min; note--) {
      if (note % 3 === 0) {
        const octave = Math.floor(note / 12) - 1;
        const name = names[note % 12];
        notes.push(
          <div key={note} className="note-label">
            {name}{octave}
          </div>
        );
      } else {
        notes.push(<div key={note} className="note-label" style={{ opacity: 0.1 }}>•</div>);
      }
    }
    return notes;
  };

  return (
    <div className="glass-panel" style={{ marginTop: step === 2 ? '0px' : '20px' }}>
      {step === 1 && (
        <>
          <h1>音高视觉比对练习</h1>
          <p className="subtitle">H5 极速流式多轨训练版</p>
        </>
      )}

      {/* Floating Back Button for Step 2 */}
      {step === 2 && (
        <button
          className="btn-back-floating"
          onClick={() => {
            handleStopAll();
            handleStopPlayback();
            isDetectionOnlyRef.current = false;
            setIsDetectionOnly(false);
            setHasAutoRecording(false);
            setHasShadowRecording(false);
            shadowSegmentsRef.current = [];
            setStep(1);
          }}
          title="返回重新上传"
        >
          ←
        </button>
      )}

      {loadingText && (
        <div className="loading-overlay">
          <div className="spinner"></div>
          <div className="loading-text">{loadingText}</div>
        </div>
      )}

      {step === 1 ? (
        <div className="upload-group">
          <h2>第一步：上传音频伴奏与原声</h2>

          <div className={`upload-card ${trackA ? 'active' : ''}`}>
            <span className="icon">🎤</span>
            <div className="title">1. 原唱纯人声干声 (WAV/MP3/M4A/MP4/MOV)</div>
            <div className="desc">{trackA ? trackA.name : '拖拽或点击文件上传，支持音视频自动提取'}</div>
            <input
              type="file"
              accept="audio/mp3,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/m4a,video/mp4,video/quicktime,.mp3,.wav,.m4a,.mp4,.mov"
              onChange={(e) => setTrackA(e.target.files[0])}
            />
          </div>

          <div className={`upload-card ${trackB ? 'active' : ''}`}>
            <span className="icon">🎹</span>
            <div className="title">2. 伴奏/伴歌声轨 (可选，WAV/MP3/M4A/MP4/MOV)</div>
            <div className="desc">{trackB ? trackB.name : '拖拽或点击文件上传，若空则使用原声放音'}</div>
            <input
              type="file"
              accept="audio/mp3,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/m4a,video/mp4,video/quicktime,.mp3,.wav,.m4a,.mp4,.mov"
              onChange={(e) => setTrackB(e.target.files[0])}
            />
          </div>

          <button
            className="btn btn-primary"
            disabled={!trackA}
            onClick={handleStartAnalysis}
            style={{ marginTop: '16px' }}
          >
            开始音高练习
          </button>
          <div
            onClick={handleStartDetection}
            style={{
              marginTop: '8px',
              color: 'var(--text-muted)',
              fontSize: '13px',
              cursor: 'pointer',
              textDecoration: 'underline',
              width: '100%',
              textAlign: 'center',
            }}
          >
            音高检测
          </div>
        </div>
      ) : (
        <div className="practice-container">
          {/* 1. 伴奏进度置于顶部 (纯检测模式下隐去) */}
          {!isDetectionOnly && (
            <div className="wavesurfer-outer" style={{ marginBottom: '12px' }}>
              <div className="wavesurfer-label">音频伴奏声轨进度 (可左右拖拽调节)</div>
              <div 
                id="waveform"
                onMouseDown={(e) => handleWaveformDragStart(e.clientX, e.currentTarget)}
                onMouseMove={(e) => handleWaveformDragMove(e.clientX, e.currentTarget)}
                onMouseUp={handleCanvasDragEnd}
                onMouseLeave={handleCanvasDragEnd}
                onTouchStart={(e) => { if (e.touches.length > 0) handleWaveformDragStart(e.touches[0].clientX, e.currentTarget); }}
                onTouchMove={(e) => { if (e.touches.length > 0) handleWaveformDragMove(e.touches[0].clientX, e.currentTarget); }}
                onTouchEnd={handleCanvasDragEnd}
                onTouchCancel={handleCanvasDragEnd}
                style={{ cursor: 'ew-resize' }}
              ></div>
            </div>
          )}

          {/* 2. 音高区域占领所有剩余高度 (Maximized Visualizer) */}
          <div className="visualizer-wrapper">
            <div className="note-axis">
              {renderNoteLabels()}
            </div>
            <div className="visualizer-canvas-container">
              <div className="timeline-cursor"></div>
              <canvas 
                ref={canvasRef} 
                className="pitch-canvas"
                onMouseDown={handleCanvasMouseDown}
                onMouseMove={handleCanvasMouseMove}
                onMouseUp={handleCanvasMouseUp}
                onMouseLeave={handleCanvasDragEnd}
                onTouchStart={handleCanvasTouchStart}
                onTouchMove={handleCanvasTouchMove}
                onTouchEnd={handleCanvasTouchEnd}
                style={{ cursor: isDetectionOnly ? 'default' : 'ew-resize' }}
              ></canvas>
            </div>
          </div>

          {/* 3. 底部操作区域 */}
          <div className="footer-controls">
            {isDetectionOnly ? (
              <div className="controls-grid">
                {!recording ? (
                  <button
                    className="btn btn-success"
                    onClick={async () => {
                      userContourRef.current = new Array(50000).fill(0);
                      detectionStartMsRef.current = performance.now();
                      try {
                        await ensureMicReady();
                        setRecording(true);
                      } catch (err) {
                        console.error(err);
                        alert('无法开启麦克风录音。');
                      }
                    }}
                  >
                    🎤 开始实时音高检测
                  </button>
                ) : (
                  <button
                    className="btn btn-danger"
                    onClick={handleStopAll}
                  >
                    ⏹ 停止检测
                  </button>
                )}
              </div>
            ) : (
              <>
                {/* Tab 切换栏 */}
                <div className="tab-bar">
                  <div
                    className={`tab-item ${trainingMode === 'auto' ? 'active' : ''}`}
                    onClick={() => {
                      handleStopAll();
                      setTrainingMode('auto');
                    }}
                  >
                    🎵 自动模式
                  </div>
                  <div
                    className={`tab-item ${trainingMode === 'shadow' ? 'active' : ''}`}
                    onClick={() => {
                      handleStopAll();
                      setTrainingMode('shadow');
                    }}
                  >
                    🎯 跟读模式
                  </div>
                </div>

                {/* ===== 自动模式 ===== */}
                {trainingMode === 'auto' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
                    <div className="controls-grid">
                      {/* 按钮 1：开始录音 / 暂停 / 继续 */}
                      {!recording ? (
                        <button
                          className="btn btn-success"
                          onClick={handleStartRecording}
                        >
                          🎤 开始录音
                        </button>
                      ) : (
                        <button
                          className="btn btn-secondary"
                          onClick={handleTogglePlayPause}
                        >
                          {playing ? '⏸ 暂停' : '▶ 继续'}
                        </button>
                      )}

                      {/* 按钮 2：原声开关 */}
                      <button
                        className="btn btn-secondary"
                        onClick={handleToggleVocal}
                        disabled={!trackB}
                      >
                        {vocalEnabled ? '🔊 原声: 开' : '🔇 原声: 关'}
                      </button>

                      {/* 按钮 3：停止并结算 */}
                      <button
                        className="btn btn-danger"
                        onClick={handleStopAll}
                        disabled={!recording}
                      >
                        ⏹ 停止
                      </button>
                    </div>
                    {hasAutoRecording && (
                      <div className="controls-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                        {isReplayingRecording ? (
                          <button className="btn btn-danger" onClick={handleStopPlayback} style={{ width: '100%' }}>
                            ⏹ 停止回放
                          </button>
                        ) : (
                          <button className="btn btn-primary" onClick={handleStartPlayback} style={{ width: '100%' }}>
                            🔊 回放录音 (带伴奏)
                          </button>
                        )}
                        <button className="btn btn-success" onClick={() => exportMixedAudio(false)} style={{ width: '100%' }}>
                          💾 导出合成音频 (.wav)
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* ===== 跟读模式 ===== */}
                {trainingMode === 'shadow' && (
                  <div className="shadow-controls">
                    {/* 统一提示文案标签，根据状态动态切换 */}
                    <p className="btn-press-hold-label">
                      {shadowState === 'idle' && '按住下方按钮播放原音，松开后跟唱该段'}
                      {shadowState === 'listening' && '🔊 播放中… 松开开始跟唱'}
                      {shadowState === 'countdown' && `🎙 准备跟唱 (倒计时 ${countdown}秒)...`}
                      {shadowState === 'following' && '🎤 正在录音，请跟唱 (点击下方按钮停止)'}
                      {shadowState === 'following_done' && '🎤 跟唱结束，可选择重新录制或下一段'}
                    </p>

                    {/* 交互按钮区域 */}
                    {shadowState === 'replaying' && (
                      <button
                        className="btn btn-secondary"
                        onClick={handleCancelRetry}
                      >
                        ✕ 取消
                      </button>
                    )}

                    {shadowState === 'countdown' && (
                      <button
                        className="btn btn-press-hold pressing"
                        style={{ filter: 'hue-rotate(60deg)', color: '#ffffff', opacity: 1, cursor: 'default' }}
                      >
                        🎙 准备... {countdown}s
                      </button>
                    )}

                    {shadowState === 'following' && (
                      <button
                        className="btn btn-press-hold btn-recording"
                        onClick={handleStopShadowRecording}
                        style={{ cursor: 'pointer' }}
                      >
                        ⏹ 正在跟唱录音中... 点击停止
                      </button>
                    )}

                    {(shadowState === 'idle' || shadowState === 'listening' || shadowState === 'following_done') && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
                        <div className="controls-grid">
                          {/* “再试一次”仅在 following_done 状态显示 */}
                          {shadowState === 'following_done' && (
                            <button
                              className="btn btn-secondary"
                              onClick={handleShadowRetry}
                            >
                              🔄 再试一次
                            </button>
                          )}

                          {/* 始终保持挂载的长按主交互按钮 */}
                          <button
                            className={`btn btn-press-hold ${shadowState === 'listening' ? 'pressing' : ''}`}
                            onMouseDown={handleShadowPressStart}
                            onMouseUp={handleShadowPressEnd}
                            onMouseLeave={(e) => { if (shadowStateRef.current === 'listening') handleShadowPressEnd(e); }}
                            onTouchStart={handleShadowPressStart}
                            onTouchEnd={handleShadowPressEnd}
                            onTouchCancel={handleShadowPressEnd}
                          >
                            {shadowState === 'idle' && '🔊 按住播放'}
                            {shadowState === 'listening' && '🔊 播放中…'}
                            {shadowState === 'following_done' && '▶ 按住继续下一段'}
                          </button>
                        </div>
                        {hasShadowRecording && shadowState === 'following_done' && (
                          <div className="controls-grid" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                            {isReplayingRecording ? (
                              <button className="btn btn-danger" onClick={handleStopPlayback} style={{ width: '100%' }}>
                                ⏹ 停止回放
                              </button>
                            ) : (
                              <button className="btn btn-primary" onClick={handleStartPlayback} style={{ width: '100%' }}>
                                🔊 回放上一段
                              </button>
                            )}
                            <button className="btn btn-success" onClick={() => exportMixedAudio(true)} style={{ width: '100%' }}>
                              💾 导出完整合成 (.wav)
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

          </div>
        </div>
      )}

      {/* 跟读模式：屏幕中央轻弹窗显示分数 (Light Glassmorphic Toast Popup) */}
      {toastScore !== null && (
        <div className="toast-score-overlay">
          <div className="toast-score-card">
            <div className="toast-score-title">跟唱得分</div>
            <div className="toast-score-value">{toastScore}分</div>
            <div className="toast-score-desc">
              {toastScore >= 85 ? '👑 唱得太完美了！' : toastScore >= 60 ? '👍 音准还可以，加油！' : '🎶 多多练习会更好！'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// === Audio Helper Functions for Mix and Export (WAV encoder) ===
async function decodeBlobToAudioBuffer(blob, offlineCtx) {
  const arrayBuffer = await blob.arrayBuffer();
  return await offlineCtx.decodeAudioData(arrayBuffer);
}

function bufferToWav(buffer) {
  const numOfChan = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // raw PCM
  const bitDepth = 16;
  
  let result;
  if (numOfChan === 2) {
    result = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
  } else {
    result = buffer.getChannelData(0);
  }
  
  const bufferLen = result.length * 2;
  const arrayBuffer = new ArrayBuffer(44 + bufferLen);
  const view = new DataView(arrayBuffer);
  
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + bufferLen, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numOfChan, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numOfChan * 2, true);
  view.setUint16(32, numOfChan * 2, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, bufferLen, true);
  
  floatTo16BitPCM(view, 44, result);
  
  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function interleave(inputL, inputR) {
  const length = inputL.length + inputR.length;
  const result = new Float32Array(length);
  let index = 0;
  let inputIndex = 0;
  while (index < length) {
    result[index++] = inputL[inputIndex];
    result[index++] = inputR[inputIndex];
    inputIndex++;
  }
  return result;
}

function floatTo16BitPCM(output, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
