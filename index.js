import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import sharp from 'sharp';
import WebSocket, { WebSocketServer } from 'ws';



// Read and parse configuration files synchronously
const configVideo = JSON.parse(fs.readFileSync('./config_video.json', 'utf8'));
const {
  HTTP_PORT,
  deviceName,
  captureSettings,
  streamSettings
} = configVideo;

let frameSkipCounter = 0; // used for skipping frames
let ffmpegProcess; // To hold the ffmpeg child process for the continuous stream
let frameBuffer = Buffer.alloc(0); // Buffer to accumulate incomplete frame data
let latestFullFrame; // hold the latest complete frame
let frameFormat;

// PNG signature and IEND chunk for frame detection
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PNG_IEND_CHUNK_TYPE_AND_CRC = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
// JPEG signature and EOI (End of Image) marker
const JPEG_START = Buffer.from([0xFF, 0xD8, 0xFF]);
const JPEG_END = Buffer.from([0xFF, 0xD9]);


async function main() {
  // sharp.concurrency(12);
  sharp.simd(true);

  console.log(timestamp(), 'Starting continuous frame capture...');
  await startContinuousFrameCapture(deviceName);
}

async function getDeviceSpecifier(deviceName) {
  if (process.platform === 'win32') {
    // On Windows we list available devices and return the specifier for dshow.
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { shell: true });
      let stderr = '';
      ffmpeg.stderr.on('data', data => {
        stderr += data.toString();
      });
      ffmpeg.on('close', () => {
        // Use regex to find lines like: "USB Video" (video)
        const videoDevices = [];
        const regex = /"([^"]+)"\s+\(video\)/g;
        let match;
        while ((match = regex.exec(stderr)) !== null) {
          videoDevices.push(match[1]);
        }
        console.error('Video devices:', videoDevices);
        const found = videoDevices.find(d => d.toLowerCase() === deviceName.toLowerCase());
        if (found) {
          console.error('Device found:', found);
          resolve(`video=${found}`);
        } else {
          console.error('Available video devices:', videoDevices);
          reject(new Error(`Device "${deviceName}" not found among: ${videoDevices.join(', ')}`));
        }
      });
    });
  } else {
    // On macOS we use avfoundation to list devices
    return new Promise((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '""'], { shell: true });
      let stderr = '';
      ffmpeg.stderr.on('data', data => {
        stderr += data.toString();
      });
      ffmpeg.on('close', () => {
        const regex = new RegExp(`\\[(\\d+)\\]\\s+${deviceName}`, 'm');
        const match = stderr.match(regex);
        if (match) {
          resolve(match[1]);
        } else {
          console.error('Device list output:\n', stderr);
          reject(new Error(`Device "${deviceName}" not found`));
        }
      });
    });
  }
}


async function startContinuousFrameCapture(deviceName) {
  if (ffmpegProcess) {
    console.warn('FFmpeg process already running. Terminating existing process.');
    ffmpegProcess.removeAllListeners('error');
    ffmpegProcess.removeAllListeners('close');
    ffmpegProcess.kill('SIGKILL'); // Force kill if already running
    ffmpegProcess = null;
    frameBuffer = Buffer.alloc(0); // Clear buffer on restart
  }

  const deviceSpecifier = await getDeviceSpecifier(deviceName);
  
  const os = process.platform;
  const ffmpegArgs = [];
  if (captureSettings.format === 'jpg') { // lossy capture
    ffmpegArgs.push(
      '-f', os === 'win32' ? 'dshow' : os === 'darwin' ? 'avfoundation' : 'v4l2',
      '-rtbufsize', '100M',
      '-video_size', captureSettings.resolution,
      '-framerate', captureSettings.fps,
      '-i', os === 'win32' ? deviceSpecifier : `${deviceSpecifier}:`,
      // '-vf', 'eq=brightness=0.25:contrast=1',
      '-pix_fmt', 'yuyv422', // yuyv422 yuv420p rgb24 rgb565
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '1',         // JPEG quality (2-31, lower is better quality)
      '-qmin', '1',
      '-'
    );
  }
  else if (captureSettings.format === 'png') { // lossless capture
    ffmpegArgs.push(
      '-f', os === 'win32' ? 'dshow' : os === 'darwin' ? 'avfoundation' : 'v4l2',
      '-rtbufsize', '100M',
      '-video_size', captureSettings.resolution,
      '-framerate', captureSettings.fps,
      '-i', os === 'win32' ? deviceSpecifier : `${deviceSpecifier}:`,
      // '-vf', 'eq=brightness=0.25:contrast=1',
      '-pix_fmt', os === 'win32' ? 'rgb565' : '0rgb',
      '-f', 'image2pipe',
      '-vcodec', 'png',
      '-compression_level', '100',
      '-'
    );
  }
  else throw 'Invalid format';

  console.log(`Starting FFmpeg with args: ${ffmpegArgs.join(' ')}`);
  ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  let lastLog;
  ffmpegProcess.stderr.on('data', data => {
    // Debug FFMPEG output
    // console.error(`FFmpeg stderr: ${data.toString()}`);
    lastLog = data;
  });

  ffmpegProcess.stdout.on('data', data => {
    frameBuffer = Buffer.concat([frameBuffer, data]);

    let startIndex = 0;
    while (true) {
      // Check for PNG signature first (it's 8 bytes, longer than JPEG's 3)
      const pngSignatureIndex = frameBuffer.indexOf(PNG_SIGNATURE, startIndex);
      // Check for JPEG signature
      const jpegSignatureIndex = frameBuffer.indexOf(JPEG_START, startIndex);

      let imageFormat = null;
      let currentImageStart = -1;
      let currentEndMarker = null;
      let currentEndMarkerLength = 0;

      // Prioritize the format that appears first if both are present in the buffer (unlikely for clean streams)
      // Or, simply detect based on which signature is found
      if (pngSignatureIndex !== -1 && (jpegSignatureIndex === -1 || pngSignatureIndex < jpegSignatureIndex)) {
        imageFormat = 'png';
        currentImageStart = pngSignatureIndex;
        currentEndMarker = PNG_IEND_CHUNK_TYPE_AND_CRC;
        currentEndMarkerLength = PNG_IEND_CHUNK_TYPE_AND_CRC.length;
      } else if (jpegSignatureIndex !== -1) {
        imageFormat = 'jpeg';
        currentImageStart = jpegSignatureIndex;
        currentEndMarker = JPEG_END;
        currentEndMarkerLength = JPEG_END.length;
      }

      if (currentImageStart === -1) {
        // No known image signature found in the current buffer segment
        break; // Exit loop, wait for more data
      }

      // Move the startIndex to the detected image's start
      startIndex = currentImageStart;

      // Find the end marker for the detected image type
      const endIndex = frameBuffer.indexOf(currentEndMarker, startIndex);

      if (endIndex === -1) {
        // Image start found, but no end yet. Need more data.
        frameBuffer = frameBuffer.slice(startIndex); // Keep the potential image start
        return; // Exit data handler, wait for next chunk
      }

      // Calculate the full length of the complete image
      const fullImageEndIndex = endIndex + currentEndMarkerLength;

      // Defensive check: ensure the full end marker and its accompanying bytes are in the buffer
      if (frameBuffer.length < fullImageEndIndex) {
        frameBuffer = frameBuffer.slice(startIndex);
        return;
      }

      frameSkipCounter++;
      const completeFrame = frameBuffer.slice(startIndex, fullImageEndIndex);

      // Store the complete frame
      frameFormat = imageFormat;
      latestFullFrame = completeFrame;

      if (frameSkipCounter % (captureSettings.frameSkip + 1) === 0) {
        // console.log(`Frame ${frameCount} ${imageFormat}: ${formatBytes(completeFrame.length)}`);
        broadcastFrameToWebSockets(completeFrame, imageFormat);
      }

      // Update the buffer to remove the processed frame and continue searching
      frameBuffer = frameBuffer.slice(fullImageEndIndex);
      startIndex = 0; // Reset startIndex to search from the beginning of the remaining buffer
    }
  });

  ffmpegProcess.on('close', code => {
    console.error(`FFmpeg process exited with code ${code}`, lastLog.toString());
    ffmpegProcess = null;
    frameBuffer = Buffer.alloc(0); // Clear buffer on process exit
    // Re-spawn logic (uncomment if needed)
    if (code !== 0) {
      console.log('Attempting to restart FFmpeg process...');
      setTimeout(() => startContinuousFrameCapture(deviceName), 5000);
    }
  });

  ffmpegProcess.on('error', err => {
    console.error(`Failed to start FFmpeg process: ${err.message}`);
    ffmpegProcess = null;
    frameBuffer = Buffer.alloc(0); // Clear buffer on error
  });
}

function timestamp() {
  const londonTime = new Date().toLocaleString('en-GB', { timeZone: 'Europe/London', hour12: true });
  return `[${londonTime}]`;
}

function hms(ms, fixed = false) {
  const totalSeconds = Math.floor(ms / 1000),
    seconds = totalSeconds % 60,
    totalMinutes = Math.floor(totalSeconds / 60),
    minutes = totalMinutes % 60,
    hours = Math.floor(totalMinutes / 60);
  if (fixed) {
    const pad = n => String(n).padStart(2, '0');
    return `${pad(hours)}h${pad(minutes)}m${pad(seconds)}s`;
  }
  return (hours ? hours + 'h' : '') + ((minutes || hours) ? minutes + 'm' : '') + seconds + 's';
}

function formatBytes(bytes) {
  const units = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes = bytes / 1024;
    i++;
  }
  return bytes.toFixed(2) + ' ' + units[i];
}

// Start the main loop
main();

// --- HTTP Server ---
const server = http.createServer(async (req, res) => {

  req.url = req.url.replace(/\?.*/, '');
  // Endpoint /
  if (req.url === '/' || req.url === '/index.html') {
    const html = await fs.promises.readFile('index.html', 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
  else if (req.url === '/frame') {
    if (latestFullFrame) {
      res.writeHead(200, { 'Content-Type': `image/${frameFormat}` }); // serve image
      res.end(latestFullFrame);
    } else {
      res.writeHead(404);
      res.end('No full frame available.');
    }
  }
  // Endpoint /settings
  else if (req.url === '/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const newSettings = JSON.parse(body);

        // Update in-memory settings
        const oldCaptureSettings = { ...captureSettings };
        Object.assign(streamSettings, newSettings.streamSettings);
        Object.assign(captureSettings, newSettings.captureSettings);
        
        // Write updated video settings to file
        const updatedConfigVideo = {
          ...configVideo,
          captureSettings,
          streamSettings
        };
        await fs.promises.writeFile('./config_video.json', JSON.stringify(updatedConfigVideo, null, 2));

        // Changing these require ffmpeg restart
        if (oldCaptureSettings.resolution !== captureSettings.resolution ||
          oldCaptureSettings.format !== captureSettings.format ||
          oldCaptureSettings.fps !== captureSettings.fps) {
            console.log('Restarting capture...');
            await startContinuousFrameCapture(deviceName);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, streamSettings, captureSettings }));
      } catch (err) {
        console.error('Failed to parse settings update:', err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
      }
    });
  } else if (req.url === '/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({captureSettings, streamSettings }));
  }
  // Endpoint 404
  else {
    res.writeHead(404);
    res.end('Not found!');
  }
});

server.listen(HTTP_PORT, () => {
  console.log(`HTTP server listening on port ${HTTP_PORT}`);
});

// --- WebSocket Server ---
const wss = new WebSocketServer({ server });
const connectedClients = new Set(); // To keep track of connected clients

wss.on('connection', ws => {
  connectedClients.add(ws);
  console.log(timestamp(), 'WebSocket client connected!', connectedClients.size);

  ws.on('close', () => {
    connectedClients.delete(ws);
    console.log(timestamp(), 'WebSocket client disconnected!', connectedClients.size);
  });

  ws.on('error', error => {
    console.error(timestamp(), 'WebSocket error:', error);
  });
});

let encoderBusy = false;
async function broadcastFrameToWebSockets(fullFrameBuffer, imageFormat) {
  if (!fullFrameBuffer || encoderBusy) return;

  const t0 = Date.now();
  let frame = fullFrameBuffer;
  if (streamSettings.reencode) {
    encoderBusy = true;
    try{
      let s = sharp(fullFrameBuffer);
      if (streamSettings.format === 'jpg') s = s.jpeg({ quality: streamSettings.quality });
      if (streamSettings.format === 'webp')  s = s.webp({ quality: streamSettings.quality, effort: streamSettings.effort })
      if (streamSettings.resolution[0] && streamSettings.resolution[1]) s = s.resize(streamSettings.resolution[0], streamSettings.resolution[1]);
      frame = await s.toBuffer();
    } catch (err) {
      console.error('Error reencoding frame!', err);
    }
  }
  encoderBusy = false;
  const t = Date.now() - t0;
  
  for (const client of connectedClients) {
    if (client.readyState !== WebSocket.OPEN) continue; // ignore closed sockets
    if (client.bufferedAmount > frame.length * streamSettings.maxFramesBuffered) continue; // dont send more than the client can ingest
    client.send(frame);
    // console.log('Frame', frameCount, formatBytes(fullFrameBuffer.length), formatBytes(frame.length), `${t}ms`);
  }
}

function broadcastMetadata(data) {
  const dataToSend = {
    // fullFrame: fullFrameBuffer.toString('base64'),
    ...data,
  };
  const message = JSON.stringify(dataToSend);
  for (const client of connectedClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}
