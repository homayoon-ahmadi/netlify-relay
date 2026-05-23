# Netlify Relay

XHTTP/HTTP proxy relay روی Netlify Edge Functions. برای دور زدن فیلترینگ اینترنت ایران.

## معماری

```
کلاینت (ایران)
  → MITM-DomainFronting (لوکال)
  → SNI: netlify.com
  → *.netlify.app (Edge Function)
  → VPS خارجی (Xray-core)
  → اینترنت
```

## پیش‌نیازها

- اکانت رایگان [Netlify](https://netlify.com)
- VPS خارجی با Xray-core (VLESS+XHTTP)
- [MITM-DomainFronting](https://github.com/patterniha/MITM-DomainFronting) روی ویندوز

## نصب

### ۱. Deploy روی Netlify

```bash
# کلون کن
git clone https://github.com/YOUR_USERNAME/netlify-relay
cd netlify-relay

# از طریق Netlify CLI
npm install -g netlify-cli
netlify login
netlify init
netlify deploy --prod
```

یا مستقیم از GitHub به Netlify وصل کن (Import from Git).

### ۲. تنظیم Environment Variable

Netlify Dashboard → Site settings → Environment variables → Add:

```
KEY:   TARGET_URL
VALUE: http://YOUR_VPS_IP:YOUR_XRAY_PORT
```

### ۳. تنظیم Xray کلاینت (v2rayNG / Nekobox)

پروتکل: `VLESS`  
آدرس: `YOUR-SITE.netlify.app`  
پورت: `443`  
TLS: `tls`  
Transport: `xhttp`  
Path: `/YOUR_UUID_PATH` (همان path که روی VPS تنظیم کردی)

### ۴. تنظیم MITM-DomainFronting

MITM را راه‌اندازی کن و آن را به عنوان system proxy ست کن. ترافیک HTTPS به `*.netlify.app` از طریق SNI جعلی عبور می‌کند.

## تنظیمات سرور (Xray روی VPS)

```json
{
  "inbounds": [{
    "port": 8080,
    "protocol": "vless",
    "settings": {
      "clients": [{"id": "YOUR_UUID"}],
      "decryption": "none"
    },
    "streamSettings": {
      "network": "xhttp",
      "xhttpSettings": {
        "path": "/YOUR_UUID_PATH"
      }
    }
  }]
}
```

## محدودیت‌ها

- Netlify Edge Functions پشتیبانی از WebSocket upgrade مستقیم ندارند — XHTTP (HTTP chunked) کار می‌کند
- پهنای باند رایگان Netlify: 100 GB در ماه
- اگر TARGET_URL روی HTTP باشد و VPS پشت TLS نباشد، ترافیک بین Netlify و VPS رمزنگاری نمی‌شود — از HTTPS روی VPS استفاده کن

## مقایسه با روش‌های مشابه

| روش | CDN | WebSocket | بدون VPS | محدودیت |
|-----|-----|-----------|----------|---------|
| این پروژه (Netlify) | Netlify | ❌ (XHTTP ✅) | ❌ | 100GB/ماه |
| MHR (Apps Script) | Google | ❌ | ✅ | 20k call/روز |
| Vercel XHTTP | Vercel | ❌ (XHTTP ✅) | ❌ | bandwidth |
| NikVPN (Codespace) | Fastly | ✅ | ❌ | 4h timeout |
