/** Public endpoints of 5050 Send (overridable at build time). */
export const API_BASE: string = import.meta.env.VITE_API_BASE ?? 'https://api.example.com';
export const DOCS_BASE: string = import.meta.env.VITE_DOCS_BASE ?? 'https://api.example.com/docs';
export const PRODUCT = '5050 Send';
export const SMTP_HOST_FALLBACK = 'smtp.example.com';
/** Operator contact (GET /system → supportEmail, else VITE_SUPPORT_EMAIL). Empty = links hidden. */
export let SUPPORT_EMAIL: string = import.meta.env.VITE_SUPPORT_EMAIL ?? '';
export function setSupportEmail(e: string | null | undefined) {
  if (e && /^[^\s@]+@[^\s@]+$/.test(e)) SUPPORT_EMAIL = e;
}
