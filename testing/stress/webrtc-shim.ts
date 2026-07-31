/**
 * Side-effect-only import: makes mediasoup-client (a browser library) run in
 * plain Node by providing werift's real WebRTC implementation as the global
 * RTCPeerConnection etc. mediasoup-client picks its internal SDP handler via
 * navigator.userAgent sniffing, not feature detection — a fake Chrome UA is
 * enough to make it pick the Chrome handler, which then drives werift's
 * RTCPeerConnection through the exact same standard W3C API surface it'd
 * use for a real browser. Verified end-to-end (real ICE+DTLS to a 'connected'
 * state, real SRTP-encrypted RTP sent and received) before this was built —
 * see the commit history / testing/README.md for how that was established.
 *
 * Must be imported before `mediasoup-client` anywhere in this process.
 */
import * as werift from 'werift';

const g = globalThis as unknown as Record<string, unknown>;

if (!g.RTCPeerConnection) {
  g.navigator = {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    mediaDevices: {},
  };
  g.RTCPeerConnection = werift.RTCPeerConnection;
  g.RTCSessionDescription = werift.RTCSessionDescription;
  g.RTCIceCandidate = werift.RTCIceCandidate;
  g.MediaStream = werift.MediaStream;
  g.MediaStreamTrack = werift.MediaStreamTrack;
}

export { werift };
