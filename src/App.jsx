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
          setPitchRange({ min, max });
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
        if (wavesurferRef.current) {
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
    if (step === 2) {
      wavesurferRef.current = WaveSurfer.create({
        container: '#waveform',
        waveColor: '#4f46e5',
        progressColor: '#a855f7',
        cursorColor: '#c084fc',
        barWidth: 2,
        barRadius: 2,
        height: 28,
        normalize: true
      });
      
      // 伴奏可选：若用户未上传伴奏，加载原唱干声作为放音与同步基准
      const audioFile = trackB || trackA;
      wavesurferRef.current.load(URL.createObjectURL(audioFile));
      
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
        }
        if (vocalAudioRef.current) {
          vocalAudioRef.current.pause();
          vocalAudioRef.current.src = '';
          vocalAudioRef.current = null;
        }
      };
    }
  }, [step, trackA, trackB]);

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
        
        // 跟读模式 following 状态时，使用虚拟播放头从 segmentStart 开始实时滚动
        let currentTime;
        if (shadowStateRef.current === 'following') {
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
        
        drawCurve(globalContourRef.current, '#f59e0b', 3, true);
        drawCurve(userContourRef.current, '#10b981', 3, false);
        
        // 实时在屏幕播放竖线位置显示当前音高 (Draw current pitch label at the vertical playhead line)
        const frameIdx = Math.floor(playheadFrame);
        if (frameIdx >= 0 && frameIdx < globalContourRef.current.length) {
          const targetMidi = globalContourRef.current[frameIdx];
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
      
      // 同步播放人声音轨
      if (vocalEnabled && vocalAudioRef.current) {
        vocalAudioRef.current.currentTime = 0;
        vocalAudioRef.current.play().catch(() => {});
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
    } else {
      wavesurferRef.current.play();
      if (vocalEnabled && vocalAudioRef.current) {
        vocalAudioRef.current.currentTime = wavesurferRef.current.getCurrentTime();
        vocalAudioRef.current.play().catch(() => {});
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
          vocalAudioRef.current.play().catch(() => {});
        }
      } else {
        vocalAudioRef.current.pause();
      }
    }
  };

  // === Mic Lifecycle Helpers (shared by auto & shadow modes) ===
  const ensureMicReady = async () => {
    if (audioContextRef.current) return; // already running
    
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    if (wavesurferRef.current) {
      wavesurferRef.current.pause();
    }
    if (vocalAudioRef.current) {
      vocalAudioRef.current.pause();
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
    calculateScore();
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
      vocalAudioRef.current.play().catch(() => {});
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

    // 自动结束跟唱：持续时间 = 录制时长 + 2秒延迟
    const segmentDuration = segmentEndRef.current - segmentStartRef.current;
    const totalDurationSec = Math.max(0.5, segmentDuration + 2);

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
      vocalAudioRef.current.play().catch(() => {});
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
              accept="audio/*,video/mp4,video/quicktime,video/*,.m4a" 
              onChange={(e) => setTrackA(e.target.files[0])} 
            />
          </div>
          
          <div className={`upload-card ${trackB ? 'active' : ''}`}>
            <span className="icon">🎹</span>
            <div className="title">2. 伴奏/伴歌声轨 (可选，WAV/MP3/M4A/MP4/MOV)</div>
            <div className="desc">{trackB ? trackB.name : '拖拽或点击文件上传，若空则使用原声放音'}</div>
            <input 
              type="file" 
              accept="audio/*,video/mp4,video/quicktime,video/*,.m4a" 
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
        </div>
      ) : (
        <div className="practice-container">
          {/* 1. 音高区域占领所有剩余高度 (Maximized Visualizer) */}
          <div className="visualizer-wrapper">
            <div className="note-axis">
              {renderNoteLabels()}
            </div>
            <div className="visualizer-canvas-container">
              <div className="timeline-cursor"></div>
              <canvas ref={canvasRef} className="pitch-canvas"></canvas>
            </div>
          </div>

          {/* 2. 伴奏进度缩减一半，紧贴音高区下方 */}
          <div className="wavesurfer-outer">
            <div className="wavesurfer-label">音频伴奏声轨进度</div>
            <div id="waveform"></div>
          </div>

          {/* 3. 底部操作区域 - 双模式 Tab */}
          <div className="footer-controls">
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
                )}
              </div>
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
