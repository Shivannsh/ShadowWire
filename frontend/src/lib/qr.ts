import QRCode from "qrcode";

/** Render a string to a PNG data URL suitable for an <img src>. */
export async function toQrDataUrl(value: string): Promise<string> {
  return QRCode.toDataURL(value, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 220,
    color: { dark: "#0a0e14", light: "#ffffff" },
  });
}
