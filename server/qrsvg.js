// QR images for the Cloudflare Worker. Uses the pure-JavaScript part of the `qrcode` package, which produces
// SVG. PNG output needs Node-only libraries, so the Worker answers PNG requests with a clear 501 instead.
import QRCode from 'qrcode/lib/browser.js';

export async function renderQr({ data, size, fg, bg, format }) {
  if (format !== 'svg') {
    const err = new Error('PNG images are not available on this deployment. Request format=svg instead.');
    err.unsupported = true;
    throw err;
  }
  const body = await QRCode.toString(data, { errorCorrectionLevel: 'H', margin: 2, width: size, color: { dark: fg, light: bg } });
  return { body, type: 'image/svg+xml' };
}
