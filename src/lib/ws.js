import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function buildFrame(payload) {
  const body = Buffer.from(payload);
  const length = body.length;
  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), body]);
  }
  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, body]);
}

function unmask(buffer, mask, start, length) {
  for (let index = 0; index < length; index += 1) {
    buffer[start + index] ^= mask[index % 4];
  }
}

class BasicWebSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;

    socket.on('data', (chunk) => this.handleData(chunk));
    socket.on('close', () => this.handleClose());
    socket.on('error', (error) => this.handleSocketError(error));
  }

  send(value) {
    if (this.socket.destroyed || this.closed) return false;
    try {
      this.socket.write(buildFrame(typeof value === 'string' ? value : JSON.stringify(value)));
      return true;
    } catch {
      this.handleClose();
      return false;
    }
  }

  close() {
    this.handleClose();
    if (!this.socket.destroyed) this.socket.end(Buffer.from([0x88, 0x00]));
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  handleSocketError(error) {
    if (!this.closed && this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
    this.handleClose();
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let offset = 2;
      let length = second & 0x7f;

      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskOffset = offset;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;

      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      if (masked) {
        const mask = this.buffer.subarray(maskOffset, maskOffset + 4);
        unmask(payload, mask, 0, payload.length);
      }

      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode === 0x1) {
        this.emit('message', payload.toString('utf8'));
      }
    }
  }
}

export function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n',
  ].join('\r\n'));
  return new BasicWebSocket(socket);
}
