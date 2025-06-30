import WebSR from '@websr/websr';
import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from 'mp4-muxer';
import Alpine from 'alpinejs';
import ImageCompare from './lib/image-compare-viewer.min';
import { MP4Demuxer } from "./demuxer_mp4";

import 'bootstrap';
import 'bootstrap/dist/css/bootstrap.min.css';
import "./index.css";
import "./lib/image-compare-viewer.min.css";

const worker = new Worker(new URL('./worker.js', import.meta.url));
const progressVideo = document.createElement('video');
const progressCanvas = document.createElement('canvas');
const progressCtx = progressCanvas.getContext('2d');

let eta = '';
let pip = null;

progressVideo.width = progressCanvas.width;
progressVideo.height = progressCanvas.height;
progressVideo.autoplay = true;
progressVideo.muted = true;
progressVideo.style.width = '300px';
progressVideo.style.height = '150px';
progressVideo.style.position = 'fixed';
progressVideo.style.top = '0px';
progressVideo.style.left = '0px';
progressVideo.style.visibility = 'hidden';

progressCanvas.style.visibility = 'hidden';
progressCanvas.id = "progress-canvas";
document.body.appendChild(progressCanvas);
document.body.appendChild(progressVideo);

let upscaled_canvas;
let original_canvas;
let video;
let ctx;

let size = 'medium';
let content = 'rl';

let tfliteModelP;
let tfliteModel;

let download_name;
let data;
let gpu;
let websr;

const weights = {
    'large': {
        'rl': require('./weights/cnn-2x-l-rl.json'),
        'an': require('./weights/cnn-2x-l-an.json'),
        '3d': require('./weights/cnn-2x-l-3d.json'),
    },
    'medium': {
        'rl': require('./weights/cnn-2x-m-rl.json'),
        'an': require('./weights/cnn-2x-m-an.json'),
        '3d': require('./weights/cnn-2x-m-3d.json'),
    },
    'small': {
        'rl': require('./weights/cnn-2x-s-rl.json'),
        'an': require('./weights/cnn-2x-s-an.json'),
        '3d': require('./weights/cnn-2x-s-3d.json'),
    }
};

const networks = {
    'small': { name: "anime4k/cnn-2x-s" },
    'medium': { name: "anime4k/cnn-2x-m" },
    'large': { name: "anime4k/cnn-2x-l" }
};

function uuidv4() {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}

document.addEventListener("DOMContentLoaded", index);

let tf;
let tflite;
let user_id;

//===================  Initial Load ===========================

function identify_user() {
    user_id = localStorage.getItem("user_id");
    if (!user_id) {
        user_id = uuidv4();
        localStorage.setItem("user_id", user_id);
    }
    if (typeof Sprig === "function") Sprig('setUserId', user_id);
}

async function index() {
    Alpine.store('state', 'init');
    Alpine.start();
    document.body.style.display = "block";

    upscaled_canvas = document.getElementById("upscaled");
    original_canvas = document.getElementById('original');

    if (!("VideoEncoder" in window)) return showUnsupported("WebCodecs");
    if (!window.showSaveFilePicker) return showUnsupported("File Write System API");

    worker.postMessage({ cmd: 'isSupported' });

    window.chooseFile = chooseFile;

    try {
        await import('@tensorflow/tfjs-backend-cpu');
        tf = await import('@tensorflow/tfjs-core');
        tflite = await import('@tensorflow/tfjs-tflite');

        tfliteModelP = tflite.loadTFLiteModel('./content_detection_mobilenet_v3.tflite', { numThreads: 1, enableProfiling: false, maxProfilingBufferEntries: 1024 });
        identify_user();
    } catch (e) {
        if (typeof Sentry !== "undefined" && Sentry.captureException) Sentry.captureException(e);
    }
}

function showUnsupported(text) {
    Alpine.store('component', text);
    Alpine.store('state', 'unsupported');
    if (typeof gtag === "function") gtag('event', 'unsupported', {});
}

function chooseFile(e) {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = loadVideo;
    input.accept = "video/mp4,video/webm,video/quicktime";
    input.click();
}

//===================  Preview ===========================

function loadVideo(input) {
    const file = input.target.files[0];
    const reader = new FileReader();

    Alpine.store('state', 'loading');

    reader.onload = function (e) {
        data = reader.result;
        setupPreview(data);
    };

    reader.readAsArrayBuffer(file);

    download_name = file.name.split(".")[0] + "-upscaled.mp4";
    Alpine.store('download_name', download_name);
    Alpine.store('filename', file.name);

    if (typeof gtag === "function") gtag('event', 'load_video', {});
}

async function setupPreview(data) {
    video = document.createElement('video');
    const fileBlob = new Blob([data], { type: "video/mp4" });
    video.src = URL.createObjectURL(fileBlob);

    const imageCompare = document.getElementById('image-compare');

    video.onloadeddata = async function () {
        Alpine.store('width', video.videoWidth);
        Alpine.store('height', video.videoHeight);
        upscaled_canvas.width = video.videoWidth * 2;
        upscaled_canvas.height = video.videoHeight * 2;
        original_canvas.width = video.videoWidth * 2;
        original_canvas.height = video.videoHeight * 2;

        imageCompare.style.height = '318px';
        imageCompare.style.width = `${Math.round(video.videoWidth / video.videoHeight * 318)}px`;
        imageCompare.style.margin = 'auto';
        imageCompare.style.position = 'relative';

        new ImageCompare(imageCompare).mount();
        video.currentTime = video.duration * 0.2 || 0;
        if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(showPreview);
        else requestAnimationFrame(showPreview);
    };

    async function showPreview() {
        if (typeof gtag === "function") gtag('event', 'preview', {});

        const fullScreenButton = document.getElementById('full-screen');
        window.initRecording = initRecording;
        window.fullScreenPreview = fullScreenPreview;

        const bitmap = await createImageBitmap(video);

        const upscaled = upscaled_canvas.transferControlToOffscreen();
        const original = original_canvas.transferControlToOffscreen();

        worker.postMessage({
            cmd: "init", data: {
                bitmap,
                upscaled,
                original,
                resolution: {
                    width: video.videoWidth,
                    height: video.videoHeight
                }
            }
        }, [bitmap, upscaled, original]);

        const contentDetectionCanvas = document.createElement('canvas');
        contentDetectionCanvas.width = 224;
        contentDetectionCanvas.height = 224;
        const contentDetectionCtx = contentDetectionCanvas.getContext('2d', { willReadFrequently: true });

        let detected = null;

        async function detectContentType() {
            const preds = { 'animation': [], 'rl': [] };
            for (let i = 0; i < 5; i++) {
                video.currentTime = (i / 10 + 0.1) * video.duration;
                if (video.requestVideoFrameCallback) await new Promise((resolve => video.requestVideoFrameCallback(resolve)));
                else await new Promise((resolve => requestAnimationFrame(resolve)));

                contentDetectionCtx.drawImage(video, video.videoWidth / 2 - 112, video.videoHeight / 2 - 112, 224, 224, 0, 0, 224, 224);

                const img = tf.browser.fromPixels(contentDetectionCanvas);
                const input = tf.div(tf.expandDims(img), 255);

                let outputTensor = (await tfliteModelP).predict(input);

                const values = outputTensor.dataSync();

                preds['animation'].push(values[0]);
                preds['rl'].push(values[1]);
            }
            video.currentTime = video.duration * 0.2 || 0;

            if (video.requestVideoFrameCallback) await new Promise((resolve => video.requestVideoFrameCallback(resolve)));
            else await new Promise((resolve => requestAnimationFrame(resolve)));

            const animation_score = preds['animation'].reduce((partialSum, a) => partialSum + a, 0);
            const rl_score = preds['rl'].reduce((partialSum, a) => partialSum + a, 0);

            const unk_thresh = 2;

            if (animation_score - rl_score > unk_thresh) return 'an';
            else if (rl_score - animation_score > unk_thresh) return 'rl';
            else return null;
        }

        try {
            tfliteModel = await tfliteModelP;
            detected = await detectContentType();
        } catch (e) {
            console.warn('Unable to load TFLite Model');
        }

        if (detected) {
            content = detected;
            await updateNetwork();
            Alpine.store('style', content);
        } else {
            content = '3d';
            await updateNetwork();
            Alpine.store('style', 'unknown');
        }

        function setFullScreenLocation() {
            if (fullScreenButton) {
                fullScreenButton.style.left = `${imageCompare.offsetLeft + 550}px`;
                fullScreenButton.style.top = `${imageCompare.offsetTop + 300}px`;
            }
        }

        setTimeout(setFullScreenLocation, 20);
        setTimeout(setFullScreenLocation, 60);
        setTimeout(setFullScreenLocation, 200);

        if (imageCompare) {
            imageCompare.addEventListener('fullscreenchange', function () {
                if (!document.fullscreenElement) {
                    upscaled_canvas.style.width = ``;
                    upscaled_canvas.style.height = ``;
                    original_canvas.style.width = ``;
                    original_canvas.style.height = ``;
                }
            });
        }

        let bitrate = getBitrate();
        const estimated_size = (bitrate / 8) * video.duration + (128 / 8) * video.duration; // Assume 128 kbps audio

        if (estimated_size > 100 * 1024 * 1024) {
            Alpine.store('target', 'writer');
        } else {
            Alpine.store('target', 'blob');
        }

        const quota = (await navigator.storage.estimate()).quota;
        if (estimated_size > quota) {
            return showError(`The video is too big. It would output a file of ${humanFileSize(estimated_size)} but the browser can only write files up to ${humanFileSize(quota)}`);
        }

        Alpine.store('size', humanFileSize(estimated_size));

        function canvasFullScreen() {
            upscaled_canvas.style.width = `${window.innerWidth}px`;
            upscaled_canvas.style.height = `${window.innerHeight}px`;
            original_canvas.style.width = `${window.innerWidth}px`;
            original_canvas.style.height = `${window.innerHeight}px`;
        }

        async function fullScreenPreview(e) {
            if (imageCompare && imageCompare.requestFullscreen) {
                await imageCompare.requestFullscreen();
                setTimeout(canvasFullScreen, 20);
                setTimeout(canvasFullScreen, 60);
                setTimeout(canvasFullScreen, 200);
            }
        }

        Alpine.store('state', 'preview');

        if (typeof Sprig === "function") {
            Sprig('setAttributes', {
                content: content,
                width: video.videoWidth,
                height: video.videoHeight
            });
        }
        setTimeout(function () {
            if (typeof Sprig === "function") {
                Sprig('identifyAndTrack', {
                    eventName: 'preview',
                    userId: user_id,
                });
            }
            if (typeof gtag === "function") gtag('event', 'sprig', {});
        }, 5000);

        window.switchNetworkSize = async function (el) {
            if (el.value !== size) {
                size = el.value;
                await updateNetwork();
            }
        };

        window.switchNetworkStyle = async function (el) {
            if (el.value !== content) {
                content = el.value;
                await updateNetwork();
            }
        };
    }
}

worker.onmessage = function (event) {
    if (event.data.cmd === 'isSupported') {
        const supported = event.data.data;
        if (!supported) return showUnsupported("WebGPU");
    } else if (event.data.cmd === 'progress') {
        Alpine.store('progress', event.data.data);
        Alpine.store('state', 'processing');
        progressView(event.data.data);
    } else if (event.data.cmd === 'process') {
        // Not used
    } else if (event.data.cmd === 'error') {
        showError(event.data.data);
        if (pip) {
            document.exitPictureInPicture();
        }
    } else if (event.data.cmd === 'eta') {
        Alpine.store('eta', event.data.data);
        eta = event.data.data;
    } else if (event.data.cmd === 'finished') {
        Alpine.store('state', 'complete');
        const blob = new Blob([event.data.data], { type: "video/mp4" });
        Alpine.store('download_url', window.URL.createObjectURL(blob));
        if (pip) {
            document.exitPictureInPicture();
        }
    }
};

function progressView(progress) {
    const w = progressCanvas.width;
    const h = progressCanvas.height;

    progressCtx.clearRect(0, 0, w, h);

    progressCtx.fillStyle = "white";
    progressCtx.fillRect(0, 0, w, h);

    progressCtx.fillStyle = "#bfdbfe";
    progressCtx.fillRect(0, 0, Math.round(w * progress / 100), h);
    progressCtx.font = "bold 32px Manrope";
    progressCtx.textAlign = 'center';

    progressCtx.fillStyle = "#232554";
    progressCtx.fillText('Free AI Video Upscaler', w / 2, 50);

    progressCtx.font = "14px Manrope";
    progressCtx.textAlign = 'center';

    progressCtx.fillText(download_name, w / 2, 80);

    progressCtx.font = "bold 48px Manrope";
    progressCtx.textAlign = 'center';

    progressCtx.fillStyle = "#2563eb";
    progressCtx.fillText(`${progress}%`, w / 2, h / 2 + 30);

    progressCtx.font = "14px Manrope";
    progressCtx.textAlign = 'center';
    progressCtx.fillStyle = "#232554";
    progressCtx.fillText(`Time remaining: ${eta}`, w / 2, h / 2 + 80);
}

async function updateNetwork() {
    const bitmap = await createImageBitmap(video);
    worker.postMessage({
        cmd: 'network',
        data: {
            name: networks[size].name,
            bitmap,
            weights: weights[size][content]
        }
    }, [bitmap]);
}

//===================  Process ===========================

async function initRecording() {
    Alpine.store('state', 'loading');
    const stream = progressCanvas.captureStream();
    progressVideo.srcObject = stream;

    progressVideo.onloadedmetadata = async function () {
        pip = await progressVideo.requestPictureInPicture();
        progressCanvas.width = pip.width;
        progressCanvas.height = pip.height;
    };

    let bitrate = getBitrate();
    const estimated_size = (bitrate / 8) * video.duration + (128 / 8) * video.duration; // Assume 128 kbps audio

    let handle;
    if (estimated_size > 100 * 1024 * 1024) {
        try {
            handle = await showFilePicker();
        } catch (e) {
            console.warn("User aborted request");
            return Alpine.store('state', 'preview');
        }
    }

    worker.postMessage({ cmd: "process", data, duration: video.duration, handle }, [data]);
}

function showError(message) {
    Alpine.store('state', 'error');
    Alpine.store('error', message);
}

function getBitrate() {
    return 1e7 * (video.videoWidth * video.videoHeight * 4) / (1280 * 720);
}

function humanFileSize(bytes, si = false, dp = 1) {
    const thresh = si ? 1000 : 1024;

    if (Math.abs(bytes) < thresh) {
        return bytes + ' B';
    }

    const units = si
        ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
        : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    let u = -1;
    const r = 10 ** dp;

    do {
        bytes /= thresh;
        ++u;
    } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);

    return bytes.toFixed(dp) + ' ' + units[u];
}

function prettyTime(secs) {
    var sec_num = parseInt(secs, 10)
    var hours = Math.floor(sec_num / 3600)
    var minutes = Math.floor(sec_num / 60) % 60
    var seconds = sec_num % 60

    return [hours, minutes, seconds]
        .map(v => v < 10 ? "0" + v : v)
        .filter((v, i) => v !== "00" || i > 0)
        .join(":")
}

async function showFilePicker() {
    const handle = await window.showSaveFilePicker({
        startIn: 'videos',
        suggestedName: download_name,
        types: [{
            description: 'Video File',
            accept: { 'video/mp4': ['.mp4'] }
        }],
    });
    return handle;
}