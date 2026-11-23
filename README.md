# CoastalTube — Liquid Glass

Web app xem video YouTube không quảng cáo với ngôn ngữ thiết kế **Liquid Glass** (kính lỏng kiểu iOS 26), port từ đặc tả Glass Recipe + Glass Motion của [YTXTube](https://github.com/Koustubh12345/YTXTube) (GPL-3.0) trên nền màu Coastal Mist. Giữ nguyên mô hình 3 tệp tĩnh, không cần build.

## Chạy ứng dụng

Không cần cài đặt gì — chỉ cần một web server tĩnh:

```bash
cd coastal-tube
python3 -m http.server 8080
# mở http://localhost:8080
```

Hoặc mở trực tiếp tệp `index.html` trong trình duyệt, hoặc tải cả thư mục lên bất kỳ hosting tĩnh nào (GitHub Pages, Netlify…). Phông rounded **Nunito** tải từ Google Fonts (mất mạng → tự dùng phông hệ thống, không chết).

## Cấu trúc tệp

| Tệp | Vai trò |
|---|---|
| `index.html` | Khung giao diện + sprite icon (Lucide-style inline SVG, không emoji) + nền aurora |
| `style.css` | Design system Liquid Glass: tokens, pipeline kính 7 lớp, fallback 3 cấp, AMOLED, responsive |
| `app.js` | Lớp dữ liệu Piped (failover, timeout), ALGO cá nhân hoá, trình phát, bình luận + **Glass Motion engine** |

## Tính năng

- **Trang chủ cá nhân hoá** — thuật toán ALGO cục bộ (localStorage): lịch sử 50 video, điểm sở thích theo kênh (+3) và từ khoá (+1), trộn feed 4+3+6+12+12, cuộn vô hạn xoay vòng chủ đề
- **Tìm kiếm & chip thể loại** — Tất cả / Âm nhạc / Trò chơi / Anime / Trailer / AI / Podcast / Thể thao
- **Trang xem video** — trình nhúng chính thức `youtube-nocookie.com` với `iv_load_policy=3`, khoá `vq=highres`, IFrame API kèm dự phòng iframe trực tiếp
- **Bình luận** — danh sách đầy đủ trên desktop, drawer bottom-sheet kính trên mobile với mini-bar kéo-tắt được
- **Video liên quan** — cột phải trên desktop, cuộn dưới player trên mobile
- **Thích / Không thích / Đăng ký** — lưu vĩnh viễn vào localStorage (bản gốc không lưu)
- **Chia sẻ** — Web Share API, dự phòng sao chép liên kết + toast kính xác nhận
- **Sáng / Tối / AMOLED** — vòng xoay 3 giao diện, tự đồng bộ theo hệ điều hành lần đầu, lưu lựa chọn
- **Liquid Glass bật/tắt được** — công tắc trong Tuỳ chọn, persist (R9); tắt kính → nền đặc, bố cục giữ nguyên
- **Skeleton shimmer** (không spinner), **empty state** rõ ràng khi máy chủ lỗi (không hiển thị dữ liệu giả như bản gốc)
- **Điều hướng History API** — nút Back của trình duyệt đóng sheet → đóng overlay → về trang chủ

## Thiết kế Liquid Glass — port từ đặc tả YTXTube

### Glass Recipe (7 lớp cho mọi bề mặt kính, mục 2.1 đặc tả)

| Bước | Trên web |
|---|---|
| 1 CLIP | `border-radius` (kính 26px, sheet 30px, capsule cho mọi bề mặt dài) |
| 2 VIBRANCY | `saturate(1.5)` trong `backdrop-filter` |
| 3 BLUR | `blur(Npx)` trong `backdrop-filter` — theo bảng tham số từng bề mặt |
| 4 LENS | mô phỏng bằng vòng sáng mép kính (rim `inset` 2 tầng) |
| 5 HIGHLIGHT | `inset 0 1px 0` + viền hairline |
| 6 SHADOW | bóng ngoài lifted + inner shadow mép (r10 α50%) |
| 7 TINT | tint trung tính vẽ cuối — **không bao giờ nhuộm màu brand** |

Bảng tham số bề mặt (khớp bảng 2.2 đặc tả):

| Bề mặt | Blur | Tint (dark / light) | Radius |
|---|---|---|---|
| Header capsule | 18 | `#16161A@65%` / `#FFF@68%` | capsule |
| Chips bar | 8 | `#121212@40%` / `#FAFAFA@40%` | capsule |
| Chip pill (đang chọn) | 8×(1−p) | black/white@0.12(1−p)+0.03p | capsule |
| Bottom sheet | 26 | glassFill(0.62) | top 30 |
| Mini bar bình luận | 18 | `#16161A@65%` / `#FFF@72%` | 20 |
| Toast | 18 | glassFill(0.9) | capsule |

### Glass Motion

- **Spring engine** (mục 3.1): `c = 2ζ√k`, semi-implicit Euler, dt ≤ 32ms — đúng 5 cặp ζ,k của pill: value(1, 1000) · press(1, 1000) · scaleX(0.6, 250) · scaleY(0.7, 250) · highlight(0.5, 300)
- **DampedDrag** (3.3): pill đuổi ngón khi kéo ngang trên chips bar, không touch slop, haptic 18/170 → 16/170 khi vượt ranh giới → 20/190 khi thả
- **Squash & stretch** (3.4): `v = velocity/10` · `scaleX ÷ (1−v×0.75)` · `scaleY × (1−v×0.25)` · clamp ±0.2 — capsule méo như màng cao su khi kéo nhanh
- **Settle-gate** (9.4): giữ trạng thái ép tới khi pill gần đích (< 2.5% range) rồi mới "nhả"
- **Press protocol** (3.2): scale 0.94 (card 0.97, mini 0.98) bằng spring(0.6, 1400) xấp xỉ bằng easing `linear()` — **không ripple**, haptic nhấn 10ms
- **Interactive highlight** (3.5): vệt sáng radial bám con trỏ, `mix-blend-mode: plus-lighter`, alpha = press progress
- **Tap pulse** (9.1): viên kính "hít vào–thở ra" 1 nhịp ~140ms khi chọn chip
- **Mini dismiss** (9.5): mini-bar bình luận kéo xuống tự do, snap-back cứng tức thì, vượt 56px hoặc 800px/s → bay 2.2×56px tween 200ms rồi tắt
- **Motion tokens** (3.1): Emphasized `cubic-bezier(0.2, 0.9, 0.2, 1)` · Morph `cubic-bezier(0.35, 0, 0.15, 1.12)` · page 220/280/90ms · sheet 280ms
- **Reduced motion** (R8): `prefers-reduced-motion` → mọi spring snap tức thì, giữ trạng thái cuối

### 3 mức degradation (R7)

1. **Kính đầy đủ** — pipeline 7 lớp trên trình duyệt có `backdrop-filter`
2. **Frosted fallback** — không hỗ trợ `backdrop-filter` → sheen gradient (White@0.14 → transparent 55% → Black@0.05) + hairline
3. **Tắt kính** — công tắc Liquid Glass (persist localStorage) hoặc `prefers-reduced-transparency` → mọi tint ép nền đặc, **bố cục không đổi** (R9)

### Quy tắc đã tuân thủ

- Kính chỉ cho bề mặt **nổi**: header, chips bar + pill, sheet, mini bar, toast — tối đa ~3 bề mặt/màn hình (R10). Card nội dung **phẳng** (7.1)
- Tint kính trung tính `#121212@38%` / `#FAFAFA@34%` — sắc màu đến từ aurora nền + nội dung, không nhuộm brand (7.4)
- Icon/chữ **phẳng phía trên kính**, pill kính nằm dưới hàng chip (R3, 7.2)
- Không kính trong kính; trường tìm kiếm trong header là mặt phẳng (R2)
- Bo góc hệ thống 8/12/20/28/32, kính 26, sheet 30, capsule mọi thứ dài (5.2)
- Typography rounded đậm (Nunito 700–900), tracking âm; like `#FF2D55`, LIVE `#CC0000`, focus ring `#3EA6FF` (5.1)

## Design tokens (Coastal Mist × Liquid Glass)

| Token | Giá trị | Vai trò |
|---|---|---|
| Deep Current | `#263C59` | Nút primary, chip active (light), logo |
| Seafoam Cloud | `#C8D9E6` | Primary dark/AMOLED, avatar text |
| Coastal Slate | `#6D89A6` | Màu hỗ trợ, link, loader |
| Nền aurora | `#BFD7E8 / #DCE9F2 / #E3D9C8` (light) | Ba khối sáng trôi chậm 44–58s — nhiên liệu cho kính |
| Radius | 8 / 12 / 20 / 28 / 32 · kính 26 · sheet 30 | Hệ thống bo góc đặc tả 5.2 |
| Motion | 220/280/90ms Emphasized · 380/480ms Morph | Tokens 3.1 |
| Z-index | 100 nav · 200 overlay · 300 modal · 500 toast | Contract giữ nguyên |

Quy tắc giữ lại từ Coastal Mist: không emoji (chỉ icon SVG), không `#000000` tuyệt đối cho text (charcoal-navy `#22344A`), nền gradient biển mờ, responsive 768px.

## Khác biệt so với bản gốc (YTXTube /web)

1. **Không còn dữ liệu giả** — khi Piped lỗi, hiện empty-state có nút thử lại thay vì 8 video mẫu cứng
2. **Avatar SVG nội tuyến** — không gọi dịch vụ ngoài (dicebear), không thể bị chèn URL độc hại
3. **3 máy chủ Piped** với failover tự động — cả khi API trả **HTTP 200 kèm `{error}`** (YouTube chặn bot máy chủ) vẫn tự chuyển máy
4. **Trending dự phòng** — nếu `/trending` rỗng hoặc toàn livestream, tự chuyển sang tìm kiếm thực, cache 5 phút
5. **Timeout theo endpoint** — 6s mặc định, 15s cho `/streams`, 10s cho `/comments`
6. **Video liên quan dự phòng** — nếu `/streams` lỗi, lấy video cùng kênh qua tìm kiếm
7. **Mở được bằng liên kết `?v=ID`** trực tiếp; lỗi → dọn URL về trang chủ kèm toast
8. **Lưu like/đăng ký/giao diện/cài đặt kính** giữa các phiên
9. **Liquid Glass đầy đủ trên web** — engine spring + pill kéo-dạy + haptics, thứ mà bản web gốc (chỉ modal blur 4px) không có

## Ghi công & giấy phép

- Kiến trúc dữ liệu (Piped client, ALGO, popstate, trình phát): port từ [YTXTube](https://github.com/Koustubh12345/YTXTube) của Koustubh12345 — **GPL-3.0**. Theo điều khoản GPL-3.0, bản phái sinh này cũng phát hành GPL-3.0.
- Thiết kế: ngôn ngữ **Liquid Glass** port từ đặc tả machine-oriented của YTXTube (Glass.kt / GlassMotion.kt / GlassNavBar.kt) sang web; bảng màu thương hiệu Coastal Mist.
- Icon: đường dẫn Lucide (ISC). Phông: Nunito (SIL OFL). Dữ liệu: máy chủ Piped cộng đồng — ứng dụng không liên kết với Google/YouTube.
