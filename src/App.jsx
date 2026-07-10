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
  
  const wavesurferRef = useRef(null);
  const workerRef = useRef(null);
  const canvasRef = useRef(null);
  const audioContextRef = useRef(null);
  const micStreamRef = useRef(null);
  const processorRef = useRef(null);
  const renderLoopIdRef = useRef(null);
  
  const globalContourRef = useRef([]);
  const userContourRef = useRef([]);
  const [pitchRange, setPitchRange] = useState({ min: 48, max: 84 });
  
  useEffect(() => {
    workerRef.current = new Worker('/worker.js');
    
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
        if (wavesurferRef.current && recording) {
          const currentTime = wavesurferRef.current.getCurrentTime();
          const frameIndex = Math.floor(currentTime * (16000 / 512));
          userContourRef.current[frameIndex] = midi;
        }
      }
    };
    
    return () => {
      if (workerRef.current) {
        workerRef.current.terminate();
      }
    };
  }, [recording]);

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
    if (step === 2 && trackB) {
      wavesurferRef.current = WaveSurfer.create({
        container: '#waveform',
        waveColor: '#4f46e5',
        progressColor: '#a855f7',
        cursorColor: '#c084fc',
        barWidth: 2,
        barRadius: 2,
        height: 60,
        normalize: true
      });
      
      wavesurferRef.current.load(URL.createObjectURL(trackB));
      
      wavesurferRef.current.on('play', () => setPlaying(true));
      wavesurferRef.current.on('pause', () => setPlaying(false));
      wavesurferRef.current.on('finish', () => handleStopAll());
      
      userContourRef.current = new Array(globalContourRef.current.length).fill(0);
      setScore(null);
      
      return () => {
        if (wavesurferRef.current) {
          wavesurferRef.current.destroy();
        }
      };
    }
  }, [step, trackB]);

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
        
        const currentTime = wavesurferRef.current ? wavesurferRef.current.getCurrentTime() : 0;
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
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      
      userContourRef.current = new Array(globalContourRef.current.length).fill(0);
      workerRef.current.postMessage({ type: 'start_recording' });
      
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      // 关键安全重构：采用系统的 native 硬件采样率（不传参），避免移动端浏览器（Safari/Chrome H5）重采样引起 onaudioprocess 哑火不触发 bug (AudioCtx Native Init)
      audioContextRef.current = new AudioCtx();
      const nativeSampleRate = audioContextRef.current.sampleRate;
      
      const source = audioContextRef.current.createMediaStreamSource(stream);
      processorRef.current = audioContextRef.current.createScriptProcessor(2048, 1, 1);
      
      source.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);
      
      processorRef.current.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        // 必须实例化一个全新、独立的 Float32Array 拷贝，确保其底层 ArrayBuffer 独立且正好为 2048 长度，排除任何可能由于 shared buffer 偏移引起的偏移与混音 Bug
        const floatData = new Float32Array(input);
        const buffer = floatData.buffer;
        if (workerRef.current) {
          workerRef.current.postMessage({
            type: 'analyze_frame',
            pcmBuffer: buffer,
            sampleRate: nativeSampleRate // 传递原声采样率，供 Worker 执行降采样
          }, [buffer]);
        }
      };
      
      wavesurferRef.current.play();
      setRecording(true);
      setScore(null);
    } catch (err) {
      console.error(err);
      alert('麦克风录音权限被拒绝或不可用。');
    }
  };

  const handleStopAll = () => {
    if (wavesurferRef.current) {
      wavesurferRef.current.pause();
    }
    
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
    
    setRecording(false);
    calculateScore();
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
    <div className="glass-panel" style={{ marginTop: '20px' }}>
      <h1>音高视觉比对练习</h1>
      <p className="subtitle">H5 极速流式多轨训练版</p>
      
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
            <div className="title">1. 原唱纯人声干声 (WAV / MP3)</div>
            <div className="desc">{trackA ? trackA.name : '拖拽或点击文件上传，用作音轨参考'}</div>
            <input 
              type="file" 
              accept="audio/*" 
              onChange={(e) => setTrackA(e.target.files[0])} 
            />
          </div>
          
          <div className={`upload-card ${trackB ? 'active' : ''}`}>
            <span className="icon">🎹</span>
            <div className="title">2. 伴奏/伴歌声轨 (WAV / MP3)</div>
            <div className="desc">{trackB ? trackB.name : '拖拽或点击文件上传，用于对唱回放'}</div>
            <input 
              type="file" 
              accept="audio/*" 
              onChange={(e) => setTrackB(e.target.files[0])} 
            />
          </div>

          <button 
            className="btn btn-primary" 
            disabled={!trackA || !trackB}
            onClick={handleStartAnalysis}
            style={{ marginTop: '16px' }}
          >
            开始音高练习
          </button>
        </div>
      ) : (
        <div>
          <div className="workspace-header">
            <h2>第二步：实唱演练</h2>
            <button 
              className="btn-back"
              onClick={() => {
                handleStopAll();
                setStep(1);
              }}
            >
              返回重新上传
            </button>
          </div>

          <div className="wavesurfer-label">音频伴奏声轨播放进度</div>
          <div className="wavesurfer-outer">
            <div id="waveform"></div>
          </div>

          <div className="visualizer-wrapper">
            <div className="note-axis">
              {renderNoteLabels()}
            </div>
            <div className="visualizer-canvas-container">
              <div className="timeline-cursor"></div>
              <canvas ref={canvasRef} className="pitch-canvas"></canvas>
            </div>
          </div>

          <div className="controls-grid">
            {!recording ? (
              <button 
                className="btn btn-success" 
                onClick={handleStartRecording}
              >
                🎤 开始录音 & 自动对唱
              </button>
            ) : (
              <button 
                className="btn btn-danger" 
                onClick={handleStopAll}
              >
                ⏹ 停止录音
              </button>
            )}
            
            <button 
              className="btn btn-secondary" 
              onClick={() => {
                if (playing) {
                  wavesurferRef.current.pause();
                } else {
                  wavesurferRef.current.play();
                }
              }}
              disabled={recording}
            >
              {playing ? '⏸ 暂停播放' : '▶ 伴奏放音'}
            </button>
          </div>

          {score !== null && (
            <div className="score-badge">
              唱功相似度得分: <span>{score}分</span>
              <p style={{ fontSize: '11px', color: '#9ca3af', marginTop: '6px' }}>
                {score >= 85 ? '唱得太完美了，音高准度极高！' : score >= 60 ? '音准还可以，再加把劲！' : '有点跑调哦，跟着音高参考线多练练吧！'}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
