// Fully fixed and robust videoEncoder.js for WebCodecs

let encoderClosed = false;

self.onmessage = ({data}) => {
    if (data.cmd === 'init') {
        // Clean up previous encoder if present
        if (self.videoEncoder && !encoderClosed) {
            try {
                self.videoEncoder.close();
            } catch (e) {}
        }
        encoderClosed = false;
        self.videoEncoder = new VideoEncoder({
            output: (chunk, meta) => {
                try {
                    const buffer = new ArrayBuffer(chunk.byteLength);
                    chunk.copyTo(buffer);
                    postMessage({
                        cmd: 'encoded',
                        buffer: buffer,
                        type: chunk.type,
                        timestamp: chunk.timestamp,
                        duration: chunk.duration,
                        meta: meta
                    }, [buffer]);
                } catch (e) {
                    postMessage({
                        cmd: 'error',
                        msg: e.message
                    });
                }
            },
            error: (e) => {
                encoderClosed = true;
                postMessage({
                    cmd: 'error',
                    msg: e.message
                });
            }
        });
        try {
            self.videoEncoder.configure(data.config);
        } catch (e) {
            postMessage({
                cmd: 'error',
                msg: e.message
            });
        }
    } else if (data.cmd === 'encode') {
        if (!encoderClosed) {
            try {
                const upscaled_frame = new VideoFrame(data.bitmap, { timestamp: data.timestamp });
                self.videoEncoder.encode(upscaled_frame, { keyFrame: data.isKeyFrame });
                upscaled_frame.close();
            } catch (e) {
                if (/closed codec/i.test(e.message)) {
                    encoderClosed = true;
                } else {
                    postMessage({
                        cmd: 'error',
                        msg: e.message
                    });
                }
            }
        }
    } else if (data.cmd === 'flush') {
        if (!encoderClosed) {
            self.videoEncoder.flush().catch(e => {
                encoderClosed = true;
                postMessage({
                    cmd: 'error',
                    msg: e.message
                });
            });
        }
    }
};