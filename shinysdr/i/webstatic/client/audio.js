// Copyright 2013, 2014, 2015, 2016 Kevin Reid <kpreid@switchb.org>
// 
// This file is part of ShinySDR.
// 
// ShinySDR is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// ShinySDR is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

define(['./types', './values', './events', './network'], function (types, values, events, network) {
  'use strict';
  
  var exports = {};
  
  var BulkDataType = types.BulkDataType;
  var Cell = values.Cell;
  var ConstantCell = values.ConstantCell;
  var Neverfier = events.Neverfier;
  
  var EMPTY_CHUNK = [];
  
  function connectAudio(url) {
    var audio = new AudioContext();
    var sampleRate = audio.sampleRate;
    function delayToBufferSize(maxDelayInSeconds) {
      var maxBufferSize = sampleRate * maxDelayInSeconds;
      var powerOfTwoBufferSize = 1 << Math.floor(Math.log(maxBufferSize) / Math.LN2);
      // Specification-defined limits
      powerOfTwoBufferSize = Math.max(256, Math.min(16384, powerOfTwoBufferSize));
      return powerOfTwoBufferSize;
    }
    
    // Stream parameters
    var numAudioChannels = null;
    
    // Queue size management
    // The queue should be large to avoid underruns due to bursty processing/delivery.
    // The queue should be small to minimize latency.
    var targetQueueSize = Math.round(0.2 * sampleRate);  // units: sample count
    // Circular buffer of queue fullness history.
    var queueHistory = new Int32Array(200);
    var queueHistoryPtr = 0;
    
    // Size of data chunks we get from network and the audio context wants, used for tuning our margins
    var inputChunkSizeSample = 0;
    var outputChunkSizeSample = 0;
    
    // Queue of chunks
    var queue = [];
    var queueSampleCount = 0;
    
    // Chunk currently being copied into audio node buffer
    var audioStreamChunk = EMPTY_CHUNK;
    var chunkIndex = 0;
    var prevUnderrun = 0;
    
    // Placeholder sample value
    var fillL = 0;
    var fillR = 0;
    
    // Flags for start/stop handling
    var started = false;
    var startStopTickle = false;
    
    //var averageSkew = 0;
    
    // local synth for debugging glitches
    //var fakePhase = 0;
    //function fake(arr) {
    //  for (var i = 0; i < arr.length; i++) {
    //    arr[i] = Math.sin(fakePhase) * 0.1;
    //    fakePhase += (Math.PI * 2) * (600 / sampleRate);
    //  }
    //}
    
    // User-facing status display
    // TODO should be faceted read-only when exported
    var errorTime = 0;
    function error(s) {
      info.error._update(String(s));
      errorTime = Date.now() + 1000;
    }
    var info = values.makeBlock({
      buffered: new values.LocalReadCell(new types.Range([[0, 2]], false, false), 0),
      target: new values.LocalReadCell(String, ''),  // TODO should be numeric w/ unit
      error: new values.LocalReadCell(new types.Notice(true), ''),
      //averageSkew: new values.LocalReadCell(Number, 0),
    });
    function updateStatus() {
      var buffered = (queueSampleCount + audioStreamChunk.length - chunkIndex) / sampleRate;
      var target = targetQueueSize / sampleRate;
      info.buffered._update(buffered / target);
      info.target._update(target.toFixed(2) + ' s');
      //info.averageSkew._update(averageSkew);
      if (errorTime < Date.now()) {
        info.error._update('');
      }
    }
    
    function updateParameters() {
      // Update queue size management
      queueHistory[queueHistoryPtr] = queueSampleCount;
      queueHistoryPtr = (queueHistoryPtr + 1) % queueHistory.length;
      var least = Math.min.apply(undefined, queueHistory);
      var most = Math.max.apply(undefined, queueHistory);
      targetQueueSize = Math.max(1, Math.round(
        ((most - least) + Math.max(inputChunkSizeSample, outputChunkSizeSample))));
      
      updateStatus();
    }
    
    network.retryingConnection(url + '?rate=' + encodeURIComponent(JSON.stringify(sampleRate)), null, function (ws) {
      ws.binaryType = 'arraybuffer';
      function lose(reason) {
        console.error('audio:', reason);
        ws.close(4000);  // first "application-specific" error code
      }
      ws.onmessage = function(event) {
        if (queue.length > 100) {
          console.log('Extreme audio overrun.');
          queue.length = 0;
          queueSampleCount = 0;
          return;
        }
        var chunk;
        if (typeof event.data === 'string') {
          if (numAudioChannels !== null) {
            console.log('audio: Got string message when already initialized');
            return;
          } else {
            var info = JSON.parse(event.data);
            if (typeof info !== 'number') {
              lose('Message was not a number');
            }
            numAudioChannels = info;
          }
          return;
        } else if (event.data instanceof ArrayBuffer) {
          // TODO think about float format portability (endianness only...?)
          chunk = new Float32Array(event.data);
        } else {
          // TODO handle in general
          lose('bad WS data');
          return;
        }
        
        if (numAudioChannels === null) {
          lose('Missing number-of-channels message');
        }
        queue.push(chunk);
        queueSampleCount += chunk.length;
        inputChunkSizeSample = chunk.length;
        updateParameters();
        if (!started) startStop();
      };
      ws.addEventListener('close', function (event) {
        error('Disconnected.');
        numAudioChannels = null;
        setTimeout(startStop, 0);
      });
      // Starting the audio ScriptProcessor will be taken care of by the onmessage handler
    });
    
    var rxBufferSize = delayToBufferSize(0.15);
    
    var ascr = audio.createScriptProcessor(rxBufferSize, 0, 2);
    ascr.onaudioprocess = function audioCallback(event) {
      var abuf = event.outputBuffer;
      var outputChunkSize = outputChunkSizeSample = abuf.length;
      var l = abuf.getChannelData(0);
      var r = abuf.getChannelData(1);
      var rightChannelIndex = numAudioChannels - 1;
      
      var totalOverrun = 0;
      
      var j;
      for (j = 0;
           chunkIndex < audioStreamChunk.length && j < outputChunkSize;
           chunkIndex += numAudioChannels, j++) {
        l[j] = audioStreamChunk[chunkIndex];
        r[j] = audioStreamChunk[chunkIndex + rightChannelIndex];
      }
      while (j < outputChunkSize) {
        // Get next chunk
        // TODO: shift() is expensive
        audioStreamChunk = queue.shift() || EMPTY_CHUNK;
        queueSampleCount -= audioStreamChunk.length;
        chunkIndex = 0;
        if (audioStreamChunk.length == 0) {
          break;
        }
        for (;
             chunkIndex < audioStreamChunk.length && j < outputChunkSize;
             chunkIndex += numAudioChannels, j++) {
          l[j] = audioStreamChunk[chunkIndex];
          r[j] = audioStreamChunk[chunkIndex + rightChannelIndex];
        }
        if (queueSampleCount > targetQueueSize) {
          var drop = Math.ceil((queueSampleCount - targetQueueSize) / 1024);
          j = Math.max(0, j - drop);
          totalOverrun += drop;
        }
      }
      if (j > 0) {
        fillL = l[j-1];
        fillR = r[j-1];
      }
      var underrun = outputChunkSize - j;
      if (underrun > 0) {
        // Fill any underrun
        for (; j < outputChunkSize; j++) {
          l[j] = fillL;
          r[j] = fillR;
        }
      }
      if (prevUnderrun != 0 && underrun != rxBufferSize) {
        // Report underrun, but only if it's not just due to the stream stopping
        error('Underrun by ' + prevUnderrun + ' samples.');
      }
      prevUnderrun = underrun;

      if (totalOverrun > 50) {  // ignore small clock-skew-ish amounts of overrun
        error('Overrun; dropping ' + totalOverrun + ' samples.');
      }
      //var totalSkew = totalOverrun - underrun;
      //averageSkew = averageSkew * 15/16 + totalSkew * 1/16;

      if (underrun > 0 && !startStopTickle) {
        // Consider stopping the audio callback
        setTimeout(startStop, 1000);
        startStopTickle = true;
      }

      updateParameters();
    };

    // Workaround for Chromium bug https://code.google.com/p/chromium/issues/detail?id=82795 -- ScriptProcessor nodes are not kept live
    window['__dummy_audio_node_reference_' + Math.random()] = ascr;
    //console.log('audio init done');
    
    function startStop() {
      startStopTickle = false;
      if (queue.length > 0 || audioStreamChunk !== EMPTY_CHUNK) {
        if (!started) {
          // Avoid unnecessary click because previous fill value is not being played.
          fillL = fillR = 0;
          
          started = true;
          ascr.connect(audio.destination);
        }
      } else {
        if (started) {
          started = false;
          ascr.disconnect(audio.destination);
        }
      }
    }
    
    return info;
  }
  
  exports.connectAudio = connectAudio;

  // TODO adapter should have gui settable parameters and include these
  // These options create a less meaningful and more 'decorative' result.
  var FREQ_ADJ = false;    // Compensate for typical frequency dependence in music so peaks are equal.
  var TIME_ADJ = false;    // Subtract median amplitude; hides strong beats.
  
  // Takes frequency data from an AnalyzerNode and provides an interface like a MonitorSink
  function AudioAnalyzerAdapter(analyzerNode, length) {
    // Constants
    var effectiveSampleRate = analyzerNode.context.sampleRate * (length / analyzerNode.frequencyBinCount);
    var info = Object.freeze({freq: 0, rate: effectiveSampleRate});
    
    // State
    var fftBuffer = new Float32Array(length);
    var lastValue = [info, fftBuffer];
    var subscriptions = [];
    var isScheduled = false;
    
    function update() {
      isScheduled = false;
      analyzerNode.getFloatFrequencyData(fftBuffer);
    
      var absolute_adj;
      if (TIME_ADJ) {
        var medianBuffer = Array.prototype.slice.call(fftBuffer);
        medianBuffer.sort(function(a, b) {return a - b; });
        absolute_adj = -100 - medianBuffer[length / 2];
      } else {
        absolute_adj = 0;
      }
      
      var freq_adj;
      if (FREQ_ADJ) {
        freq_adj = 1;
      } else {
        freq_adj = 0;
      }
      
      for (var i = 0; i < length; i++) {
        fftBuffer[i] = fftBuffer[i] + absolute_adj + freq_adj * Math.pow(i, 0.5);
      }
      
      var newValue = [info, fftBuffer];  // fresh array, same contents, good enough.
    
      // Deliver value
      lastValue = newValue;
      if (subscriptions.length && !isScheduled) {
        isScheduled = true;
        // TODO should call a Scheduler instead but we don't have one.
        // (Though also, a basic rAF loop seems to be about the right rate to poll the AnalyzerNode for new data.)
        requestAnimationFrame(update);
      }
      // TODO replace this with something async
      for (var i = 0; i < subscriptions.length; i++) {
        (0,subscriptions[i])(newValue);
      }
    }
    
    // Output cell
    this.fft = new Cell(new types.BulkDataType('dff', 'b'));  // TODO BulkDataType really isn't properly involved here
    this.fft.get = function () {
      return lastValue;
    };
    // TODO: put this on a more general and sound framework (same as BulkDataCell)
    this.fft.subscribe = function (callback) {
      subscriptions.push(callback);
      if (!isScheduled) {
        requestAnimationFrame(update);
      }
    };
    
    // Other elements expected by Monitor widget
    Object.defineProperty(this, '_implements_shinysdr.i.blocks.IMonitor', {enumerable: false});
    this.freq_resolution = new ConstantCell(Number, length);
    this.signal_type = new ConstantCell(types.any, {kind: 'USB', sample_rate: effectiveSampleRate});
  }
  Object.defineProperty(AudioAnalyzerAdapter.prototype, '_reshapeNotice', {value: new Neverfier()});
  Object.freeze(AudioAnalyzerAdapter.prototype);
  Object.freeze(AudioAnalyzerAdapter);
  exports.AudioAnalyzerAdapter = AudioAnalyzerAdapter;
    
  return Object.freeze(exports);
});