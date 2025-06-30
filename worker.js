import {MP4Demuxer} from "./demuxer_mp4";
import {ArrayBufferTarget, FileSystemWritableFileStreamTarget, Muxer} from "mp4-muxer";
import WebSR from "../../websr/";

let gpu;
let websr;
let upscaled_canvas;
let original_canvas;
let resolution;
let ctx;

function getMP4Data(data, type, duration) {
    return new Promise(function (resolve, reject) {
        let configToReturn;
        let dataToReturn = [];
        let lastChunk = false;
        const demuxer = new MP4Demuxer(data, type, {
            onConfig(config) {
                configToReturn = config;
                if(configToReturn && lastChunk) return resolve({config: configToReturn, encoded_chunks: dataToReturn});
            },
            onData(chunks) {
                for(let chunk of chunks){
                    dataToReturn.push(chunk);
                }
                let last_time = chunks[chunks.length-1].timestamp/(1000*1000);
                if(Math.abs(duration - last_time) < 1) lastChunk = true;
                if(configToReturn && lastChunk) return resolve({config: configToReturn, encoded_chunks: dataToReturn});
            },
            setStatus: function (){}
        });
    });
}

const weights = require('./weights/cnn-2x-m-rl.json');

async function isSupported(){
    gpu = await WebSR.initWebGPU();
    postMessage({cmd: 'isSupported', data: gpu !== false});
}

async function init(config){
    if(!gpu) gpu = await WebSR.initWebGPU();
    websr = new WebSR({
        network_name: "anime4k/cnn-2x-m",
        weights,
        resolution: config.resolution,
        gpu: gpu,
        canvas: config.upscaled
    });
    resolution = config.resolution;
    upscaled_canvas = config.upscaled;
    original_canvas = config.original;
    ctx = original_canvas.getContext('bitmaprenderer');

    const bitmap2 = await createImageBitmap(config.bitmap, {
        resizeHeight: config.resolution.height*2,
        resizeWidth: config.resolution.width*2,
    });
    await websr.render(config.bitmap);
    ctx.transferFromImageBitmap(bitmap2)
}

self.onmessage = async function (event){
    if(!event.data.cmd) return;
    if(event.data.cmd === 'init'){
        await init(event.data.data);
    } else if(event.data.cmd === 'isSupported'){
        await isSupported();
    } else if (event.data.cmd === 'process'){
        await initRecording(event.data.data, event.data.duration, event.data.handle)
    }  else if(event.data.cmd === 'network'){
        await switchNetwork(event.data.data.name, event.data.data.weights, event.data.data.bitmap)
    }
}

async function switchNetwork(name, weights, bitmap){
    websr.switchNetwork(name, weights);
    await websr.render(bitmap);
}

async function initRecording(data, duration, handle){
    let bitrate = 1e7 * (resolution.width*resolution.height*4)/(1280*720);
    let videoData, audioData, writer;
    if(handle) writer = await handle.createWritable();

    try {
        audioData = await getMP4Data(data, 'audio', duration);
    } catch (e) {
        console.log('No audio track found, skipping....');
    }

    try{
        videoData = await getMP4Data(data, 'video', duration);
    } catch (e) {
        postMessage({cmd: 'error', data: 'No video found'});
        return;
    }

    const config = videoData.config;
    const encoded_chunks = videoData.encoded_chunks;
    const target = writer ? new FileSystemWritableFileStreamTarget(writer) : new ArrayBufferTarget();

    const muxerOptions = {
        target: target,
        video: {
            codec: 'avc',
            width: resolution.width*2,
            height: resolution.height*2
        },
        firstTimestampBehavior: 'offset',
        fastStart: 'in-memory'
    };
    if(audioData){
        muxerOptions.audio = {
            codec:  'aac',
            numberOfChannels: audioData.config.numberOfChannels,
            sampleRate: audioData.config.sampleRate
        }
    }
    const muxer = new Muxer(muxerOptions);

    let codec_string = resolution.width*resolution.height *4 > 921600 ? 'avc1.42003e': 'avc1.42001f';
    const videoEncoderConfig = {
        codec: codec_string,
        width: resolution.width*2,
        height: resolution.height*2,
        bitrate: Math.round(bitrate),
        framerate: 1e6/videoData.encoded_chunks[0].duration,
    };

    const decode_callbacks = [];
    const decoder = new VideoDecoder({
        output(frame) {
            const callback = decode_callbacks.shift();
            if (callback) callback(frame);
        },
        error(e) {
            postMessage({cmd: 'error', data: e.message});
        }
    });

    const encode_callbacks = [];
    let encoderClosed = false;
    const encoder = new VideoEncoder({
        output: (chunk, meta) => {
            const callback = encode_callbacks.shift();
            try {
                muxer.addVideoChunk(chunk, meta);
            } catch (e) {
                postMessage({cmd: 'error', data: e.message});
            }
            if (callback) callback();
        },
        error: (e) => {
            encoderClosed = true;
            postMessage({cmd: 'error', data: e.message});
        }
    });

    encoder.configure(videoEncoderConfig);
    decoder.configure(config);

    const decode_promises = [];
    const decoder_buffer_length = 1000;
    for (let i = 0; i < Math.min(encoded_chunks.length, decoder_buffer_length); i ++){
        let chunk = encoded_chunks[i];
        decode_promises.push(new Promise(function (resolve) {
            const callback = function (frame){ resolve(frame);}
            decode_callbacks.push(callback);
        }));
        try{
            decoder.decode(chunk);
        } catch (e) {
            postMessage({cmd: 'error', data: e.message});
        }
    }

    const encode_promises = [];
    const start_time = performance.now();
    let last_decode = performance.now();
    let flush_check = setInterval(function () {
        if(performance.now() - last_decode > 1000 && (encoded_chunks.length - current_frame < 10)) decoder.flush()
    }, 100);
    let current_frame;

    for (let i =0; i < decode_promises.length; i++){
        const decode_promise = decode_promises[i];
        const source_chunk = encoded_chunks[i];
        const frame = await decode_promise;
        last_decode = performance.now();

        const bitmap2 = await createImageBitmap(frame, {
            resizeHeight: resolution.height*2,
            resizeWidth: resolution.width*2,
        });

        let render_promise = websr.render(frame);
        ctx.transferFromImageBitmap(bitmap2);
        await render_promise;
        await websr.context.device.queue.onSubmittedWorkDone();

        let time_since = performance.now() - last_decode;
        await new Promise(function (resolve) {
            setTimeout(resolve, Math.max(0, 30-time_since))
        })

        current_frame = i;
        const new_frame = new VideoFrame(upscaled_canvas,{ timestamp: frame.timestamp, duration: frame.duration, alpha: "discard"});

        let progress  = Math.floor((frame.timestamp/(1000*1000))/duration*100);
        let time_elapsed = performance.now() - start_time;
        if(time_elapsed > 1000){
            const processing_rate = ((frame.timestamp/(1000*1000))/duration*100)/time_elapsed;
            let eta = Math.round(((100-progress)/processing_rate)/1000);
            postMessage({cmd: 'eta', data: prettyTime(eta)})
        } else {
            postMessage({cmd: 'eta', data: 'calculating...'})
        }
        postMessage({cmd: 'progress', data: progress})

        encode_promises.push(new Promise(function (resolve) {
            const callback = function (){ resolve();}
            encode_callbacks.push(callback);
        }));

        try{
            if (!encoderClosed) {
                encoder.encode(new_frame, {keyFrame: source_chunk.type === 'key'});
            }
        } catch (e) {
            if (/closed codec/i.test(e.message)) {
                encoderClosed = true;
            } else {
                postMessage({cmd: 'error', data: e.message});
            }
        }
        frame.close();
        new_frame.close();

        if( i +decoder_buffer_length < encoded_chunks.length){
            let chunk = encoded_chunks[i+decoder_buffer_length];
            decode_promises.push(new Promise(function (resolve) {
                const callback = function (frame){ resolve(frame);}
                decode_callbacks.push(callback);
            }));
            try{
                decoder.decode(chunk);
            } catch (e) {}
            last_decode = performance.now();
        }
    }

    clearInterval(flush_check);

    // Wait for all encoding to finish and flush encoder (to get last chunks)
    let last_encode = performance.now();
    flush_check = setInterval(function () {
        if(performance.now() - last_encode > 1000 && !encoderClosed) encoder.flush()
    }, 100);

    for (let i =0; i < encode_promises.length; i++){
        const encode_promise = encode_promises[i];
        await encode_promise;
        last_encode = performance.now();
    }
    clearInterval(flush_check);

    // The critical part: flush and wait for ALL pending output/callbacks
    try {
        if (!encoderClosed) {
            await encoder.flush();
            encoder.close();
            encoderClosed = true;
        }
        decoder.close();

        // Wait a tick to ensure all encoder output callbacks are processed
        await new Promise(resolve => setTimeout(resolve, 0));

        if(audioData) {
            const source_audio_chunks = audioData.encoded_chunks;
            for (let audio_chunk of source_audio_chunks){
                muxer.addAudioChunk(audio_chunk);
            }
        }

        muxer.finalize();

        if(writer){
            await writer.close();
            postMessage({cmd: 'finished', data: null}, []);
        } else{
            postMessage({cmd: 'finished', data: muxer.target.buffer}, [muxer.target.buffer]);
        }
    } catch (e) {
        postMessage({cmd: 'error', data: e.message});
    }
}

function prettyTime(secs){
    var sec_num = parseInt(secs, 10)
    var hours   = Math.floor(sec_num / 3600)
    var minutes = Math.floor(sec_num / 60) % 60
    var seconds = sec_num % 60

    return [hours,minutes,seconds]
        .map(v => v < 10 ? "0" + v : v)
        .filter((v,i) => v !== "00" || i > 0)
        .join(":")
}