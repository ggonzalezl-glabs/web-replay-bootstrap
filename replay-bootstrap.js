/**
 * FanDuel Replay Bootstrap
 *
 * Self-contained recording script for Unity WebGL game pages.
 * Load via <script> tag in the game HTML template or gameBridge, or inject
 * via RN injectJavaScript(). Same file works in all contexts.
 *
 * Recording path: VideoEncoder + OPFS (cross-platform, iOS 16.4+, Android)
 *                 MediaRecorder fallback (older Android WebView)
 *
 * Transfer channel (auto-detected):
 *   React Native WebView → base64 chunked postMessage → onNativeTransferChunk/Done
 *                          (POC; production: fetch POST to nativereplay:// scheme)
 *   Browser (web client) → window.parent.postMessage onUploadToS3 (ArrayBuffer, Transferable)
 *                          same channel the gameBridge MediaRecorder already uses
 *
 * Exposes:
 *   window.__startRecording()  — call at match start (or hooked into gameBridge automatically)
 *   window.__stopRecording()   — call at match end   (or hooked into gameBridge automatically)
 *   window.__lastRecordingUrl  — object URL of finished MP4 (available after stop)
 *
 * Dependencies: mp4-muxer — loaded from CDN if not already present on the page.
 */
(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------
  var RECORDING_FPS           = 15;
  var CAPTURE_INTERVAL_MS     = Math.floor(1000 / RECORDING_FPS);    // 66 ms
  var FRAME_DURATION_US       = Math.round(1000000 / RECORDING_FPS); // 66 667 µs
  var TARGET_BITRATE_BPS      = 1000000;                             // 1 Mbps
  var KEYFRAME_EVERY_FRAMES   = RECORDING_FPS * 4;                  // 60 frames — keyframe every 4 s
  var BYTES_PER_MB            = 1048576;
  var TENTH_MB_DIVISOR        = BYTES_PER_MB / 10;                  // 104 857.6
  var RECORDER_TIMESLICE_MS   = 1000;                               // MediaRecorder chunk interval
  var CANVAS_RETRY_INTERVAL_MS = 500;
  var CANVAS_MAX_RETRIES      = 10;
  var TRANSFER_CHUNK_CHARS    = 50000;  // base64 chars per RN postMessage chunk
  var BTOA_CHUNK_BYTES        = 8192;   // bytes per btoa loop iteration (avoids stack overflow)
  var MP4_MUXER_CDN           = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5/build/mp4-muxer.umd.min.js';

  // ---------------------------------------------------------------------------
  // Context detection
  // ---------------------------------------------------------------------------
  var IS_RN = typeof window.ReactNativeWebView !== 'undefined';

  console.log('[replay] bootstrap loading — context:', IS_RN ? 'ReactNative' : 'web');

  // ---------------------------------------------------------------------------
  // Load mp4-muxer if not already present, then start canvas search
  // ---------------------------------------------------------------------------
  if (typeof Mp4Muxer !== 'undefined') {
    init();
  } else {
    var _muxerScript = document.createElement('script');
    _muxerScript.src = MP4_MUXER_CDN;
    _muxerScript.onload = init;
    _muxerScript.onerror = function () {
      console.error('[replay] failed to load mp4-muxer from', MP4_MUXER_CDN);
    };
    document.head.appendChild(_muxerScript);
  }

  // ---------------------------------------------------------------------------
  // Canvas search — poll until Unity canvas appears
  // ---------------------------------------------------------------------------
  function init() {
    console.log('[replay] mp4-muxer ready — searching for canvas');
    var attempts = 0;
    function findCanvas() {
      var canvases = document.querySelectorAll('canvas');
      console.log('[replay] canvas search attempt', attempts + 1, '— found', canvases.length, 'canvas(es)');
      if (canvases.length > 0) {
        // Pick the largest canvas — Unity's game canvas.
        var best = canvases[0];
        for (var i = 1; i < canvases.length; i++) {
          if (canvases[i].width * canvases[i].height > best.width * best.height) best = canvases[i];
        }
        setup(best);
      } else if (attempts < CANVAS_MAX_RETRIES) {
        attempts++;
        setTimeout(findCanvas, CANVAS_RETRY_INTERVAL_MS);
      } else {
        console.error('[replay] canvas not found after', attempts, 'attempts');
      }
    }
    findCanvas();
  }

  // ---------------------------------------------------------------------------
  // Recording setup — runs once the canvas is found
  // ---------------------------------------------------------------------------
  function setup(canvas) {
    console.log('[replay] canvas found —', canvas.width + 'x' + canvas.height,
      'id:', canvas.id || '(none)');

    if (canvas.width === 0 || canvas.height === 0) {
      console.warn('[replay] canvas has zero dimensions — recording may produce empty output');
    }

    // H.264 requires even dimensions.
    var w = (canvas.width  || 640) & ~1;
    var h = (canvas.height || 480) & ~1;

    // Stats — shared between recording path and FPS ticker.
    var _isRecording  = false;
    var _recStart     = 0;
    var _recFrames    = 0;
    var _blobMB       = null;
    var _queueSize    = 0;
    var _encodedBytes = 0;

    // -------------------------------------------------------------------------
    // Path 1: VideoEncoder + mp4-muxer + OPFS (cross-platform)
    //
    // Uses an offscreen 2D canvas as an intermediate blit target so Unity's
    // WebGL canvas stays on its normal GPU compositing path. Direct
    // VideoFrame(webglCanvas) can trigger a slow readback mode that persists
    // for the canvas lifetime; blitting via drawImage avoids that.
    // -------------------------------------------------------------------------
    if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' &&
        typeof Mp4Muxer !== 'undefined') {

      console.log('[replay] VideoEncoder + Mp4Muxer available — using offscreen 2D canvas path');

      var _config = { codec: 'avc1.640028', width: w, height: h, bitrate: TARGET_BITRATE_BPS, framerate: RECORDING_FPS };
      var _muxer        = null;
      var _encoder      = null;
      var _recording    = false;
      var _frameCount   = 0;
      var _captureTimer = null;
      var _opfsHandle   = null;
      var _opfsWritable = null;

      var _offscreen = document.createElement('canvas');
      _offscreen.width  = w;
      _offscreen.height = h;
      var _ctx2d = _offscreen.getContext('2d');

      // Sets up OPFS file + writable stream + muxer + encoder.
      // FileSystemWritableFileStreamTarget streams encoded chunks to disk as
      // they arrive — JS heap stays near-flat for the entire session.
      async function _initEncoder() {
        var root = await navigator.storage.getDirectory();
        _opfsHandle   = await root.getFileHandle('replay.mp4', { create: true });
        _opfsWritable = await _opfsHandle.createWritable();
        _muxer = new Mp4Muxer.Muxer({
          target: new Mp4Muxer.FileSystemWritableFileStreamTarget(_opfsWritable),
          video: { codec: 'avc', width: w, height: h },
          fastStart: false,           // moov atom at end — no in-memory buffering
          firstTimestampBehavior: 'offset',
        });
        _encoder = new VideoEncoder({
          output: function (chunk, meta) {
            _muxer.addVideoChunk(chunk, meta);
            _encodedBytes += chunk.byteLength;
          },
          error: function (e) { console.error('[replay] VideoEncoder error:', String(e)); },
        });
        _encoder.configure(_config);
        _frameCount = 0;
      }

      // setTimeout → rAF scheduling: register a rAF exactly RECORDING_FPS times per
      // second, leaving the frames in between uncontested for Unity's own rAF loop.
      function _scheduleCapture() {
        _captureTimer = setTimeout(function () {
          _captureTimer = null;
          if (!_recording) return;
          requestAnimationFrame(function (ts) {
            if (!_recording) return;
            try {
              _ctx2d.drawImage(canvas, 0, 0, w, h);
              // duration must be explicit — WKWebView sets it to null otherwise.
              var frame = new VideoFrame(_offscreen, {
                timestamp: Math.round(ts * 1000),
                duration: FRAME_DURATION_US,
              });
              _encoder.encode(frame, { keyFrame: _frameCount % KEYFRAME_EVERY_FRAMES === 0 });
              frame.close();
              _frameCount++;
              _recFrames = _frameCount;
              _queueSize = _encoder.encodeQueueSize;
            } catch (e) {
              console.error('[replay] VideoFrame capture error:', String(e));
            }
            _scheduleCapture();
          });
        }, CAPTURE_INTERVAL_MS);
      }

      window.__startRecording = async function () {
        if (_recording) { console.warn('[replay] already recording'); return; }
        try { await _initEncoder(); } catch (e) {
          console.error('[replay] OPFS init failed:', String(e)); return;
        }
        _recording = true; _isRecording = true;
        _recStart = performance.now(); _recFrames = 0;
        _blobMB = null; _queueSize = 0; _encodedBytes = 0;
        console.log('[replay] started (VideoEncoder + OPFS, ' + RECORDING_FPS + ' fps)');
        _scheduleCapture();
      };

      window.__stopRecording = async function () {
        if (!_recording) { console.warn('[replay] not recording'); return; }
        _recording = false; _isRecording = false; _queueSize = 0;
        if (_captureTimer !== null) { clearTimeout(_captureTimer); _captureTimer = null; }
        try {
          await _encoder.flush();
          _muxer.finalize();
          await _opfsWritable.close();

          var _file = await _opfsHandle.getFile();
          _blobMB = Math.round(_file.size / TENTH_MB_DIVISOR) / 10;
          console.log('[replay] OPFS file ready —', _file.size, 'bytes (' + _blobMB + ' MB)');

          // Read once — used for both the in-app replay URL and the transfer.
          var _buffer = await _file.arrayBuffer();
          var _blob = new Blob([_buffer], { type: 'video/mp4' });
          window.__lastRecordingUrl = URL.createObjectURL(_blob);
          console.log('[replay] object URL:', window.__lastRecordingUrl);

          if (IS_RN) {
            window.parent.postMessage(JSON.stringify({ method: 'onRecordingReady', parameters: {} }), '*');
            _transferToRN(_buffer);
          } else {
            _transferToHost(_buffer);
          }

          await _opfsHandle.remove();
          _opfsHandle = null; _opfsWritable = null;

        } catch (e) {
          console.error('[replay] stop/transfer error:', String(e));
        }
      };

    // -------------------------------------------------------------------------
    // Path 2: MediaRecorder + captureStream (Android fallback)
    // -------------------------------------------------------------------------
    } else if (typeof MediaRecorder !== 'undefined' && typeof canvas.captureStream === 'function') {

      console.log('[replay] VideoEncoder not available — using MediaRecorder fallback (Android only)');
      var _stream   = canvas.captureStream(RECORDING_FPS);
      var _mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
      var _recorder = new MediaRecorder(_stream, { mimeType: _mimeType });
      var _chunks   = [];

      _recorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) _chunks.push(e.data); };
      _recorder.onstop = function () {
        var _blob = new Blob(_chunks, { type: _recorder.mimeType });
        window.__lastRecordingUrl = URL.createObjectURL(_blob);
        _blobMB = Math.round(_blob.size / TENTH_MB_DIVISOR) / 10;
        console.log('[replay] MediaRecorder blob ready —', _blob.size, 'bytes (' + _blobMB + ' MB)');
        _blob.arrayBuffer().then(function (_buffer) {
          if (IS_RN) {
            window.parent.postMessage(JSON.stringify({ method: 'onRecordingReady', parameters: {} }), '*');
            _transferToRN(_buffer);
          } else {
            _transferToHost(_buffer);
          }
        });
      };
      _recorder.onerror = function (e) { console.error('[replay] MediaRecorder error:', String(e.error || e)); };

      window.__startRecording = function () {
        if (_recorder.state !== 'inactive') { console.warn('[replay] already recording'); return; }
        _chunks = []; _isRecording = true; _recStart = performance.now();
        _recorder.start(RECORDER_TIMESLICE_MS);
        console.log('[replay] started (MediaRecorder, mimeType:', _mimeType + ')');
      };
      window.__stopRecording = function () {
        if (_recorder.state === 'inactive') { console.warn('[replay] not recording'); return; }
        _isRecording = false;
        _recorder.stop();
        return Promise.resolve(); // async-compatible return for gameBridge hook
      };

    // -------------------------------------------------------------------------
    // No recording API available
    // -------------------------------------------------------------------------
    } else {
      console.warn('[replay] no recording API available —',
        'VideoEncoder:', typeof VideoEncoder,
        'MediaRecorder:', typeof MediaRecorder,
        'captureStream:', typeof canvas.captureStream);
      window.__startRecording = function () { console.warn('[replay] recording not available on this platform'); };
      window.__stopRecording  = function () { console.warn('[replay] recording not available on this platform'); return Promise.resolve(); };
    }

    // -------------------------------------------------------------------------
    // gameBridge lifecycle hook
    // Wires __startRecording / __stopRecording into the gameBridge match
    // lifecycle automatically when gameBridge is present on the page.
    // No external trigger (RN injection or host postMessage) needed.
    // -------------------------------------------------------------------------
    if (window.gameBridge) {
      var _origStart = window.gameBridge.onStartGame;
      window.gameBridge.onStartGame = function (s) {
        if (_origStart) _origStart.call(this, s);
        window.__startRecording && window.__startRecording();
      };
      var _origReturn = window.gameBridge.onReturnToContainer;
      window.gameBridge.onReturnToContainer = function () {
        var _self = this;
        // Wait for recording to fully finalise before letting the gameBridge
        // call gameInstance.Quit() — mirrors the gameBridge's own finalizeRecordingPromise.
        var _stopResult = window.__stopRecording && window.__stopRecording();
        var _stopPromise = (_stopResult && typeof _stopResult.then === 'function') ? _stopResult : Promise.resolve();
        _stopPromise.finally(function () {
          if (_origReturn) _origReturn.call(_self);
        });
      };
      console.log('[replay] gameBridge lifecycle hooks installed');
    }

    console.log('[replay] setup complete — window.__startRecording / window.__stopRecording ready');

    // -------------------------------------------------------------------------
    // FPS / stats ticker — RN only
    // Posts onDebugFps every second so the RN debug overlay stays current.
    // Web clients have no equivalent overlay so the ticker is skipped.
    // -------------------------------------------------------------------------
    if (IS_RN) {
      var _fpsFrames = 0;
      var _fpsLast = performance.now();
      function _fpsTick(now) {
        _fpsFrames++;
        if (now - _fpsLast >= 1000) {
          var _mem = performance.memory ? Math.round(performance.memory.usedJSHeapSize / BYTES_PER_MB) : null;
          window.parent.postMessage(JSON.stringify({
            method: 'onDebugFps',
            parameters: {
              fps:             _fpsFrames,
              memoryMB:        _mem,
              recording:       _isRecording,
              elapsedSeconds:  _isRecording ? Math.round((now - _recStart) / 1000) : 0,
              frameCount:      _recFrames,
              blobSizeMB:      _blobMB,
              encodeQueueSize: _queueSize,
              encodedMB:       _isRecording && _encodedBytes > 0
                                 ? Math.round(_encodedBytes / TENTH_MB_DIVISOR) / 10
                                 : null,
            },
          }), '*');
          _fpsFrames = 0;
          _fpsLast = now;
        }
        requestAnimationFrame(_fpsTick);
      }
      requestAnimationFrame(_fpsTick);
    }
  }

  // ---------------------------------------------------------------------------
  // Transfer: React Native (POC — base64 chunked postMessage)
  //
  // Splits the base64-encoded video into TRANSFER_CHUNK_CHARS-char slices so
  // each postMessage stays under session.ts's 65 536-char receive limit.
  //
  // Production replacement: fetch POST to nativereplay:// scheme —
  // WKURLSchemeHandler (iOS) / shouldInterceptRequest (Android) intercepts the
  // request body natively, writes chunks to native FS, no base64 overhead.
  // ---------------------------------------------------------------------------
  function _transferToRN(buffer) {
    var _bytes = new Uint8Array(buffer);
    var _binary = '';
    for (var i = 0; i < _bytes.length; i += BTOA_CHUNK_BYTES) {
      _binary += String.fromCharCode.apply(null, _bytes.subarray(i, Math.min(i + BTOA_CHUNK_BYTES, _bytes.length)));
    }
    var _base64 = btoa(_binary);
    var _total  = Math.ceil(_base64.length / TRANSFER_CHUNK_CHARS);
    console.log('[replay] transferring to native —', _total, 'chunk(s),', buffer.byteLength, 'bytes');
    for (var ci = 0; ci < _total; ci++) {
      window.parent.postMessage(JSON.stringify({
        method: 'onNativeTransferChunk',
        parameters: {
          index: ci,
          total: _total,
          size:  buffer.byteLength,
          data:  _base64.slice(ci * TRANSFER_CHUNK_CHARS, (ci + 1) * TRANSFER_CHUNK_CHARS),
        },
      }), '*');
    }
    window.parent.postMessage(JSON.stringify({
      method: 'onNativeTransferDone',
      parameters: { size: buffer.byteLength },
    }), '*');
  }

  // ---------------------------------------------------------------------------
  // Transfer: Web host page (onUploadToS3 — same channel gameBridge uses)
  //
  // Posts the ArrayBuffer as a Transferable — zero-copy, the parent page takes
  // ownership. The host page (fanduel.com / worldwinner.com) stores it in its
  // own OPFS/IndexedDB and uploads to S3 in the background, even after the
  // game iframe closes.
  // ---------------------------------------------------------------------------
  function _transferToHost(buffer) {
    console.log('[replay] transferring to host page —', buffer.byteLength, 'bytes');
    window.parent.postMessage(
      {
        message: JSON.stringify({
          method: 'onUploadToS3',
          parameters: { mimeType: 'video/mp4', size: buffer.byteLength },
        }),
        buffer: buffer,
      },
      '*',
      [buffer], // Transferable — zero-copy handoff to parent
    );
  }

})();
