/* ============================================================
   CoastalTube — app.js
   Xem video YouTube không quảng cáo · giao diện Liquid Glass
   (kính lỏng kiểu iOS 26, port từ đặc tả YTXTube Glass Motion)
   Dữ liệu: API Piped (failover nhiều máy chủ, timeout 6s)
   Phát video: trình nhúng chính thức youtube-nocookie + IFrame API
   Cá nhân hoá: thuật toán cục bộ trên localStorage (port từ YTXTube)
   Dự án phái sinh của YTXTube (GPL-3.0) — Koustubh12345/YTXTube
   ============================================================ */
'use strict';

/* ────────────────────────────────────────────
   0. Cấu hình & trạng thái
   ──────────────────────────────────────────── */

// Máy chủ Piped — cái đầu đã được kiểm tra hoạt động; các cái sau là dự phòng.
const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.ducks.party',
  'https://pipedapi.adminforge.de',
];
let currentInstance = PIPED_INSTANCES[0];

const TRENDING_REGION = 'US';
const FETCH_TIMEOUT_MS = 6000;
const SCROLL_THRESHOLD_PX = 600;
const STAGGER_MS = 80;

// Chip thể loại = truy vấn tìm kiếm (giống bản gốc).
const CATEGORIES = [
  { label: 'Tất cả', q: '' },
  { label: 'Âm nhạc', q: 'music' },
  { label: 'Trò chơi', q: 'gaming' },
  { label: 'Anime', q: 'anime' },
  { label: 'Trailer', q: 'official trailer' },
  { label: 'AI', q: 'ai' },
  { label: 'Podcast', q: 'podcast' },
  { label: 'Thể thao', q: 'sports' },
];

const LS_KEYS = {
  history: 'coastaltube_history',
  prefs: 'coastaltube_prefs',
  theme: 'coastaltube_theme',
  glass: 'coastaltube_glass',
  likes: 'coastaltube_likes',
  subs: 'coastaltube_subs',
};

const state = {
  mode: 'feed',            // 'feed' | 'search'
  category: 'Tất cả',
  query: '',
  feedPage: 0,
  loading: false,
  watchVisible: false,
  currentVideo: null,
  ytPlayer: null,
  pendingPlayerId: null,
  currentComments: [],
};

/* ────────────────────────────────────────────
   1. Tiện ích chung
   ──────────────────────────────────────────── */

const $ = (sel) => document.querySelector(sel);

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function icon(name, cls = 'icon') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

let toastTimer = null;
function showToast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth; // chạy lại animation
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

// Số liệu hiển thị kiểu YouTube tiếng Việt: 456 N · 1,2 Tr · 2,3 T
function formatCompactVN(value, fallback = '—') {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 0) return fallback;
  const fmt = (v) => v.toLocaleString('vi-VN', { maximumFractionDigits: 1 });
  if (n >= 1e9) return fmt(n / 1e9) + ' T';
  if (n >= 1e6) return fmt(n / 1e6) + ' Tr';
  if (n >= 1e3) return fmt(n / 1e3) + ' N';
  return String(n);
}

function formatViews(value) {
  const compact = formatCompactVN(value, null);
  return compact === null ? '' : `${compact} lượt xem`;
}

function formatSubs(value) {
  const compact = formatCompactVN(value, null);
  return compact === null ? '' : `${compact} người đăng ký`;
}

function formatDuration(sec) {
  const s = parseInt(sec, 10);
  if (isNaN(s) || s < 0) return 'LIVE';
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (hrs > 0) return `${hrs}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

const AGO_VN = {
  second: 'giây trước', seconds: 'giây trước',
  minute: 'phút trước', minutes: 'phút trước',
  hour: 'giờ trước', hours: 'giờ trước',
  day: 'ngày trước', days: 'ngày trước',
  week: 'tuần trước', weeks: 'tuần trước',
  month: 'tháng trước', months: 'tháng trước',
  year: 'năm trước', years: 'năm trước',
};

// "3 years ago" → "3 năm trước"; ngày ISO → ngày kiểu vi-VN; còn lại giữ nguyên.
function timeAgoVN(str) {
  if (!str || str === 'None' || str === 'null') return '';
  const m = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i.exec(str);
  if (m) return `${m[1]} ${AGO_VN[m[2].toLowerCase()] || ''}`.trim();
  const d = new Date(str);
  if (!isNaN(d.getTime()) && /^\d{4}-/.test(String(str))) {
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  return String(str);
}

/* Avatar SVG nội tuyến — không phụ thuộc dịch vụ ngoài, an toàn XSS. */
const AVATAR_BG = ['#263C59', '#6D89A6', '#4A6076', '#55708C', '#3A5273'];
function initialsAvatar(name) {
  // 'None' là giá trị rỗng của Piped
  const label = (!name || String(name).trim() === '' || String(name) === 'None') ? 'CV' : String(name).trim();
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  const bg = AVATAR_BG[hash % AVATAR_BG.length];
  const letters = label.replace(/[^a-zA-Z0-9À-ỹà-ỹ\s]/g, '').split(/\s+/).filter(Boolean);
  const initials = ((letters[0] || 'C')[0] + (letters.length > 1 ? (letters[letters.length - 1][0] || '') : '')).toUpperCase() || 'C';
  // Lưu ý: không dùng ký tự ' hoặc " trong SVG — data-URI được nhúng vào url('...')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="${bg}"/><text x="24" y="30" font-family="sans-serif" font-size="17" font-weight="600" fill="#F2F4F6" text-anchor="middle">${escapeHtml(initials)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function thumbFor(id) {
  return `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`;
}

function extractVideoId(url) {
  if (!url) return '';
  const m = /[?&]v=([\w-]{6,})/.exec(url)
    || /\/(?:shorts|embed|live)\/([\w-]{6,})/.exec(url);
  if (m) return m[1];
  return url.split('/').pop().split('?')[0] || '';
}

/* ────────────────────────────────────────────
   2. Lớp dữ liệu Piped (failover + timeout)
   ──────────────────────────────────────────── */

async function fetchJSON(path, timeoutMs = FETCH_TIMEOUT_MS) {
  const order = [currentInstance, ...PIPED_INSTANCES.filter((i) => i !== currentInstance)];
  let lastError = null;
  for (const base of order) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Piped có thể trả HTTP 200 kèm {error: "..."} khi YouTube chặn máy chủ
      // (LOGIN_REQUIRED / bot check) → coi như lỗi của instance này, thử máy khác
      if (data && typeof data.error === 'string') {
        throw new Error('piped: ' + data.error.slice(0, 140));
      }
      currentInstance = base;
      return data;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
    }
  }
  throw lastError || new Error('Tất cả máy chủ dữ liệu đều lỗi');
}

function parseVideoItem(item) {
  const id = extractVideoId(item.url || item.id || '');
  const isLive = parseInt(item.duration, 10) === -1;
  return {
    id,
    title: item.title || '(không có tiêu đề)',
    uploaderName: item.uploaderName || 'Kênh chưa xác định',
    uploaderUrl: item.uploaderUrl || '',
    uploaderAvatar: initialsAvatar(item.uploaderName),
    thumbnail: thumbFor(id),
    duration: isLive ? 'LIVE' : formatDuration(item.duration),
    isLive,
    views: formatViews(item.views),
    uploaded: timeAgoVN(item.uploadedDate || item.uploaded || ''),
  };
}

/* Trending đôi khi trả về toàn livestream (lỗi phổ biến của Piped) —
   khi đó chuyển sang tìm kiếm thực theo chủ đề phổ biến. Cache 5 phút. */
const TRENDING_CACHE_MS = 5 * 60 * 1000;
const FALLBACK_TOPICS = ['music', 'gaming', 'official trailer', 'podcast'];
let trendingCache = { at: 0, items: [] };

async function fetchTrending() {
  if (trendingCache.items.length > 0 && Date.now() - trendingCache.at < TRENDING_CACHE_MS) {
    return trendingCache.items;
  }

  // 1) Cách chuẩn: /trending
  try {
    const data = await fetchJSON(`/trending?region=${TRENDING_REGION}`);
    const list = Array.isArray(data) ? data : (data.items || []);
    const nonLive = list.map(parseVideoItem).filter((v) => v.id && !v.isLive);
    if (nonLive.length > 0) {
      trendingCache = { at: Date.now(), items: nonLive };
      return nonLive;
    }
  } catch { /* sang phương án dự phòng bên dưới */ }

  // 2) Trending lỗi/toàn livestream → tìm kiếm thực (không dùng dữ liệu giả)
  const merged = [];
  const seen = new Set();
  for (const q of FALLBACK_TOPICS) {
    try {
      const items = await fetchSearch(q);
      for (const v of items) {
        if (!seen.has(v.id) && !v.isLive) {
          seen.add(v.id);
          merged.push(v);
        }
        if (merged.length >= 24) break;
      }
    } catch { /* bỏ qua chủ đề lỗi */ }
    if (merged.length >= 24) break;
  }
  if (merged.length === 0) throw new Error('Không có nguồn dữ liệu nào khả dụng');
  trendingCache = { at: Date.now(), items: merged };
  return merged;
}

async function fetchSearch(q) {
  const data = await fetchJSON(`/search?q=${encodeURIComponent(q)}&filter=videos`);
  const list = Array.isArray(data) ? data : (data.items || []);
  return list.map(parseVideoItem).filter((v) => v.id);
}

/* ────────────────────────────────────────────
   3. ALGO — cá nhân hoá cục bộ (port từ YTXTube)
   ──────────────────────────────────────────── */

const ALGO = {
  STOP_WORDS: new Set([
    'the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'with',
    'by', 'from', 'official', 'video', 'music', 'hd', '4k', 'remastered', 'ft',
    'feat', 'mv', 'lyrics', 'full', 'live', 'episode', 'ep', 'season', 'part', 'new',
  ]),

  getHistory() {
    try { return JSON.parse(localStorage.getItem(LS_KEYS.history) || '[]'); }
    catch { return []; }
  },

  getPreferences() {
    try { return JSON.parse(localStorage.getItem(LS_KEYS.prefs) || '{"keywords":{},"channels":{}}'); }
    catch { return { keywords: {}, channels: {} }; }
  },

  recordWatch(video) {
    if (!video || !video.id) return;
    try {
      let history = this.getHistory().filter((it) => it.id !== video.id);
      history.unshift({
        id: video.id,
        title: video.title,
        uploader: video.uploaderName,
        timestamp: Date.now(),
      });
      if (history.length > 50) history = history.slice(0, 50);
      localStorage.setItem(LS_KEYS.history, JSON.stringify(history));

      const prefs = this.getPreferences();
      if (video.uploaderName) {
        prefs.channels[video.uploaderName] = (prefs.channels[video.uploaderName] || 0) + 3;
      }
      if (video.title) {
        const words = video.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
        words.forEach((w) => {
          if (w.length > 2 && !this.STOP_WORDS.has(w)) {
            prefs.keywords[w] = (prefs.keywords[w] || 0) + 1;
          }
        });
      }
      localStorage.setItem(LS_KEYS.prefs, JSON.stringify(prefs));
    } catch (e) {
      console.warn('ALGO ghi nhận:', e);
    }
  },

  // Thứ tự ưu tiên: kênh 1, từ khoá 1, kênh 2, từ khoá 2 (giữ nguyên bản gốc).
  getTopInterests() {
    const prefs = this.getPreferences();
    const sortedKeywords = Object.entries(prefs.keywords || {})
      .sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const sortedChannels = Object.entries(prefs.channels || {})
      .sort((a, b) => b[1] - a[1]).map((e) => e[0]);

    const interests = [];
    if (sortedChannels[0]) interests.push(sortedChannels[0]);
    if (sortedKeywords[0]) interests.push(sortedKeywords[0]);
    if (sortedChannels[1]) interests.push(sortedChannels[1]);
    if (sortedKeywords[1]) interests.push(sortedKeywords[1]);
    return interests;
  },
};

// Trang chủ "Tất cả": trộn 4 + 3 + 6 + 12 + 12 từ sở thích & thịnh hành (bản gốc).
async function getRecommendedFeed() {
  const interests = ALGO.getTopInterests();
  if (interests.length === 0) return fetchTrending();

  const primary = await fetchSearch(interests[0]);
  const secondary = interests.length > 1 ? await fetchSearch(interests[1]) : [];
  const trending = await fetchTrending();

  const combined = [];
  const seen = new Set();
  const addUnique = (list, count) => {
    let added = 0;
    for (const v of list) {
      if (!seen.has(v.id)) {
        seen.add(v.id);
        combined.push(v);
        added++;
        if (added >= count) break;
      }
    }
  };

  addUnique(primary, 4);
  addUnique(secondary, 3);
  addUnique(trending, 6);
  addUnique(primary, 12);
  addUnique(trending, 12);

  if (combined.length === 0) return fetchTrending();
  return combined;
}

/* ────────────────────────────────────────────
   4. Giao diện: Sáng / Tối / AMOLED (5.1 đặc tả)
   ──────────────────────────────────────────── */

const THEMES = ['light', 'dark', 'amoled'];
const THEME_LABEL = { light: 'Sáng', dark: 'Tối', amoled: 'AMOLED' };
// Nút header luôn hiển thị biểu tượng của giao diện TIẾP theo
const THEME_ICON = { light: '#i-moon', dark: '#i-contrast', amoled: '#i-sun' };

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const use = $('#theme-icon use');
  if (use) use.setAttribute('href', THEME_ICON[theme] || '#i-moon');
  const btn = $('#theme-toggle');
  if (btn) btn.title = `Giao diện hiện tại: ${THEME_LABEL[theme] || theme}`;
  const opt = $('#option-theme span');
  if (opt) opt.textContent = `Giao diện: ${THEME_LABEL[theme] || theme}`;
}

function initTheme() {
  let theme = null;
  try { theme = localStorage.getItem(LS_KEYS.theme); } catch { /* bỏ qua */ }
  if (!THEMES.includes(theme)) {
    theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  applyTheme(theme);
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  applyTheme(next);
  try { localStorage.setItem(LS_KEYS.theme, next); } catch { /* bỏ qua */ }
}

/* ────────────────────────────────────────────
   5. Render: feed, thẻ video, skeleton
   ──────────────────────────────────────────── */

/* Chips dựng MỘT lần; đổi danh mục chỉ đồng bộ trạng thái + pill kính chạy spring */
function buildChips() {
  const track = $('#chips-track');
  if (!track) return;
  track.querySelectorAll('.chip').forEach((el) => el.remove());
  CATEGORIES.forEach((cat) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.textContent = cat.label;
    btn.onclick = () => selectCategory(cat);
    track.appendChild(btn);
  });
}

function syncChips({ pulse = true } = {}) {
  const track = $('#chips-track');
  if (!track) return;
  let activeIdx = 0;
  track.querySelectorAll('.chip').forEach((btn, i) => {
    const on = CATEGORIES[i] && CATEGORIES[i].label === state.category;
    btn.classList.toggle('active', on);
    if (on) activeIdx = i;
  });
  if (window.ChipsPill) window.ChipsPill.sync(activeIdx, { pulse });
}

function cardStatsLine(v) {
  const parts = [v.views, v.uploaded].filter(Boolean);
  return parts.join(' · ');
}

function videoCardHTML(v, index) {
  const badge = v.isLive || v.duration === 'LIVE'
    ? `<span class="cm-thumb-badge live">TRỰC TIẾP</span>`
    : `<span class="cm-thumb-badge">${escapeHtml(v.duration)}</span>`;
  return `
    <div class="cm-thumb">
      <img src="${v.thumbnail}" alt="${escapeHtml(v.title)}" loading="lazy"
           onerror="this.onerror=null;this.src='${thumbFor(v.id)}';">
      ${badge}
    </div>
    <div class="cm-card-body">
      <span class="cm-avatar" style="background-image:url('${v.uploaderAvatar}')"></span>
      <div class="cm-card-meta">
        <span class="video-title">${escapeHtml(v.title)}</span>
        <span class="video-channel">${escapeHtml(v.uploaderName)}</span>
        <span class="video-stats">${escapeHtml(cardStatsLine(v))}</span>
      </div>
    </div>`;
}

function renderGrid(videos, { append = false, startIndex = 0 } = {}) {
  const grid = $('#video-grid');
  if (!append) grid.innerHTML = '';
  videos.forEach((v, i) => {
    const card = document.createElement('article');
    card.className = 'video-card cm-entry';
    card.style.setProperty('--stagger', `${Math.min(startIndex + i, 10) * STAGGER_MS}ms`);
    card.innerHTML = videoCardHTML(v);
    card.onclick = () => openWatch(v);
    grid.appendChild(card);
  });
}

function renderSkeletons(count = 8) {
  const grid = $('#video-grid');
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const sk = document.createElement('div');
    sk.className = 'skeleton-card';
    sk.innerHTML = `
      <div class="skeleton-thumb"></div>
      <div class="skeleton-row">
        <div class="skeleton-avatar"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px">
          <div class="skeleton-line title"></div>
          <div class="skeleton-line sub"></div>
        </div>
      </div>`;
    grid.appendChild(sk);
  }
}

function showFeedEmpty(title, text) {
  const box = $('#feed-empty');
  $('#feed-empty-title').textContent = title;
  $('#feed-empty-text').textContent = text;
  box.hidden = false;
}

function hideFeedEmpty() { $('#feed-empty').hidden = true; }

function setLoader(visible) { $('#feed-loader').hidden = !visible; }

/* ────────────────────────────────────────────
   6. Luồng trang chủ: chip, tìm kiếm, cuộn vô hạn
   ──────────────────────────────────────────── */

async function loadFeed() {
  if (state.loading) return;
  state.loading = true;
  hideFeedEmpty();
  renderSkeletons(8);
  setLoader(false);
  try {
    let videos;
    if (state.mode === 'feed') {
      videos = state.category === 'Tất cả'
        ? await getRecommendedFeed()
        : await fetchSearch(CATEGORIES.find((c) => c.label === state.category)?.q || state.category);
    } else {
      videos = await fetchSearch(state.query);
    }
    state.feedPage = 0;
    renderGrid(videos);
    if (videos.length === 0) {
      showFeedEmpty('Không tìm thấy kết quả', 'Hãy thử từ khoá khác, hoặc quay lại danh mục “Tất cả”.');
    }
  } catch (err) {
    console.warn('Tải feed lỗi:', err);
    $('#video-grid').innerHTML = '';
    showFeedEmpty('Không thể tải dữ liệu', 'Máy chủ dữ liệu đang bận hoặc không phản hồi. Kiểm tra kết nối rồi thử lại nhé.');
  } finally {
    state.loading = false;
  }
}

// Cuộn vô hạn: xoay vòng chủ đề theo sở thích (bản gốc), chế độ tìm kiếm chỉ 1 trang.
async function loadMoreFeed() {
  if (state.loading || state.mode === 'search') return;
  state.loading = true;
  setLoader(true);
  try {
    const interests = ALGO.getTopInterests();
    const topics = interests.length > 0 ? interests : ['trending'];
    const topic = topics[state.feedPage % topics.length];
    const videos = topic === 'trending' ? await fetchTrending() : await fetchSearch(topic);
    state.feedPage++;
    const start = $('#video-grid').children.length;
    renderGrid(videos, { append: true, startIndex: start });
  } catch (err) {
    console.warn('Tải thêm lỗi:', err);
    showToast('Không tải thêm được — thử lại sau');
  } finally {
    setLoader(false);
    state.loading = false;
  }
}

function selectCategory(cat) {
  if (state.loading && cat.label === state.category) return;
  state.mode = 'feed';
  state.category = cat.label;
  state.query = '';
  $('#results-bar').hidden = true;
  $('#chips-bar').hidden = false;
  syncChips();
  loadFeed();
}

function runSearch(q) {
  const query = q.trim();
  if (!query) return;
  state.mode = 'search';
  state.query = query;
  state.category = '';
  syncChips({ pulse: false });
  $('#chips-bar').hidden = true;
  $('#results-label').innerHTML = `Kết quả cho <strong>${escapeHtml(query)}</strong>`;
  $('#results-bar').hidden = false;
  loadFeed();
}

function clearSearch() {
  selectCategory(CATEGORIES[0]);
}

/* ────────────────────────────────────────────
   7. Trang xem video
   ──────────────────────────────────────────── */

function showWatch(show) {
  state.watchVisible = show;
  $('#feed-view').hidden = show;         // đang xem video → ẩn trang chủ
  $('#watch-view').hidden = !show;       // không xem → ẩn trang xem
  $('#chips-bar').hidden = show;
  $('#results-bar').hidden = show || state.mode !== 'search';
}

function setPlayerPlaceholder() {
  $('#player-box').innerHTML = '<div class="skeleton-thumb" style="aspect-ratio:16/9;border-radius:0"></div>';
}

function loadPlayer(id) {
  const box = $('#player-box');
  const params = 'autoplay=1&enablejsapi=1&rel=0&modestbranding=1&iv_load_policy=3&playsinline=1&vq=highres';
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${params}`;

  if (window.YT && window.YT.Player) {
    box.innerHTML = '<div id="cm-player-target"></div>';
    state.ytPlayer = new YT.Player('cm-player-target', {
      videoId: id,
      playerVars: {
        autoplay: 1, enablejsapi: 1, rel: 0, modestbranding: 1,
        iv_load_policy: 3, playsinline: 1,
      },
    });
    try { state.ytPlayer.setPlaybackQuality('highres'); } catch { /* bỏ qua */ }
  } else {
    // Dự phòng: iframe nhúng trực tiếp, vẫn phát được nếu IFrame API bị chặn.
    box.innerHTML = `
      <iframe src="${src}" title="Trình phát video"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
    state.pendingPlayerId = id;
    window.onYouTubeIframeAPIReady = () => {
      if (state.pendingPlayerId === id && state.currentVideo && state.currentVideo.id === id) {
        state.pendingPlayerId = null;
        loadPlayer(id);
      }
    };
  }
}

function destroyPlayer() {
  state.pendingPlayerId = null;
  if (state.ytPlayer) {
    try { state.ytPlayer.destroy(); } catch { /* bỏ qua */ }
    state.ytPlayer = null;
  }
  $('#player-box').innerHTML = '';
}

function resetWatchUI() {
  $('#watch-title').textContent = '';
  $('#watch-meta').textContent = '';
  $('#watch-channel-name').textContent = '';
  $('#watch-channel-subs').textContent = '';
  $('#watch-channel-avatar').style.backgroundImage = '';
  $('#like-count').textContent = '—';
  setVoteUI(null);
  setSubscribeUI(null);
  $('#desc-text').textContent = '';
  $('#desc-toggle').hidden = true;
  $('#related-list').innerHTML = relatedSkeletonHTML(6);
  $('#desktop-comments-list').innerHTML = '';
  $('#comment-count').textContent = '';
  $('#sheet-comments-list').innerHTML = '';
  $('#sheet-comment-count').textContent = '';
  $('#comment-preview').hidden = true;
}

function relatedSkeletonHTML(count) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `
      <div class="related-item">
        <div class="skeleton-thumb" style="width:168px;flex:none;aspect-ratio:16/9"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px">
          <div class="skeleton-line title"></div>
          <div class="skeleton-line sub"></div>
        </div>
      </div>`;
  }
  return html;
}

async function openWatch(video, { push = true } = {}) {
  if (!video || !video.id) return;
  state.currentVideo = video;
  if (push) {
    window.history.pushState({ view: 'watch', videoId: video.id }, '', `?v=${encodeURIComponent(video.id)}`);
  }
  ALGO.recordWatch(video);

  resetWatchUI();
  showWatch(true);

  $('#watch-title').textContent = video.title;
  $('#watch-meta').textContent = [video.views, video.uploaded].filter(Boolean).join(' · ');
  $('#watch-channel-name').textContent = video.uploaderName;
  $('#watch-channel-avatar').style.backgroundImage = `url('${video.uploaderAvatar}')`;

  loadPlayer(video.id);
  fetchStreamDetails(video.id);
  fetchComments(video.id);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function goHome(push = true) {
  destroyPlayer();
  state.currentVideo = null;
  showWatch(false);
  if (state.mode === 'search') {
    $('#chips-bar').hidden = true;
    $('#results-bar').hidden = false;
  } else {
    $('#chips-bar').hidden = false;
    $('#results-bar').hidden = true;
  }
  if (push) window.history.pushState({ view: 'feed' }, '', '?');
}

async function fetchStreamDetails(videoId) {
  // Guard: người dùng đã rời video này thì bỏ qua kết quả cũ
  if (!state.currentVideo || state.currentVideo.id !== videoId) return;
  try {
    const data = await fetchJSON(`/streams/${encodeURIComponent(videoId)}`, 15000);
    if (!state.currentVideo || state.currentVideo.id !== videoId) return;

    if (data.likes !== undefined && data.likes !== null) {
      $('#like-count').textContent = formatCompactVN(data.likes);
    }
    if (data.uploader) {
      $('#watch-channel-name').textContent = data.uploader;
    }
    if (data.uploaderSubscriberCount) {
      $('#watch-channel-subs').textContent = formatSubs(data.uploaderSubscriberCount);
      if (data.uploader) setSubscribeUI(isSubscribed(data.uploader));
    }
    if (data.uploaderAvatar && data.uploader) {
      $('#watch-channel-avatar').style.backgroundImage = `url('${initialsAvatar(data.uploader)}')`;
    }
    const dateVN = timeAgoVN(data.uploadDate);
    const viewsVN = formatViews(data.views);
    const metaParts = [viewsVN, dateVN].filter(Boolean);
    if (metaParts.length) $('#watch-meta').textContent = metaParts.join(' · ');

    if (data.description) {
      setDescription(String(data.description));
    }

    const related = (data.relatedStreams || []).map(parseVideoItem).filter((v) => v.id);
    renderRelated(related);
    setVoteUI(getLikeState(videoId), formatCompactVN(data.likes, '—'));
  } catch (err) {
    console.warn('Chi tiết video:', err);
    if (!state.currentVideo || state.currentVideo.id !== videoId) return;
    // Không tải được chi tiết vẫn cho đăng ký theo tên kênh đã biết
    setSubscribeUI(isSubscribed(state.currentVideo.uploaderName));
    // Fallback video liên quan: tìm kiếm theo tên kênh (thay vì bỏ trống)
    try {
      const alt = await fetchSearch(state.currentVideo.uploaderName);
      const altRelated = alt.filter((v) => v.id && v.id !== videoId);
      if (altRelated.length > 0) {
        renderRelated(altRelated);
        return;
      }
    } catch { /* vẫn hiển thị thông báo lỗi bên dưới */ }
    $('#related-list').innerHTML = `
      <div class="cm-empty" style="margin-top:0;padding:2.5rem 1rem">
        ${icon('inbox', 'icon icon-xl')}
        <p>Không tải được video liên quan.</p>
      </div>`;
  }
}

function setDescription(text) {
  const el = $('#desc-text');
  const btn = $('#desc-toggle');
  el.textContent = text;
  el.classList.remove('collapsed');
  requestAnimationFrame(() => {
    const overflowing = el.scrollHeight > el.clientHeight + 4;
    el.classList.toggle('collapsed', overflowing);
    btn.hidden = !overflowing;
    btn.textContent = 'Thêm';
  });
  btn.onclick = () => {
    const collapsed = el.classList.toggle('collapsed');
    btn.textContent = collapsed ? 'Thêm' : 'Thu gọn';
  };
}

function renderRelated(videos) {
  const list = $('#related-list');
  list.innerHTML = '';
  if (videos.length === 0) {
    list.innerHTML = '<p class="cm-mono" style="padding:12px 4px">Không có video liên quan.</p>';
    return;
  }
  videos.forEach((v, i) => {
    const item = document.createElement('div');
    item.className = 'related-item cm-entry';
    item.style.setProperty('--stagger', `${Math.min(i, 8) * STAGGER_MS}ms`);
    item.innerHTML = `
      <div class="cm-related-thumb">
        <img src="${v.thumbnail}" alt="${escapeHtml(v.title)}" loading="lazy">
      </div>
      <div class="cm-related-body">
        <span class="related-title">${escapeHtml(v.title)}</span>
        <span class="related-channel">${escapeHtml(v.uploaderName)}</span>
        <span class="related-stats">${escapeHtml(cardStatsLine(v))}</span>
      </div>`;
    item.onclick = () => openWatch(v);
    list.appendChild(item);
  });
}

/* ────────────────────────────────────────────
   8. Bình luận (trang desktop + drawer di động)
   ──────────────────────────────────────────── */

function commentItemHTML(c, i) {
  const author = (!c.uploaderName || c.uploaderName === 'None') ? 'Kênh chưa xác định' : c.uploaderName;
  const avatar = initialsAvatar(author);
  const likes = formatCompactVN(c.likeCount, '');
  const replies = parseInt(c.replyCount, 10);
  return `
    <div class="comment-item cm-entry" style="--stagger:${Math.min(i, 6) * STAGGER_MS}ms">
      <span class="cm-avatar sm" style="background-image:url('${avatar}')"></span>
      <div class="cm-comment-body">
        <div class="cm-comment-head">
          <span class="cm-comment-author">${escapeHtml(author)}</span>
          <span class="cm-comment-time">${escapeHtml(timeAgoVN(c.commentedTime))}</span>
        </div>
        <p class="cm-comment-text">${escapeHtml(c.commentText || '')}</p>
        <div class="cm-comment-foot">
          <button type="button" class="icon-btn sm cm-comment-like-btn" data-cindex="${i}" aria-label="Thích bình luận">
            ${icon('thumb-up', 'icon')}<span class="cm-comment-likes">${likes}</span>
          </button>
          ${replies > 0 ? `<span class="cm-comment-replies">${formatCompactVN(replies)} phản hồi</span>` : ''}
        </div>
      </div>
    </div>`;
}

function renderCommentsHTML(list, container) {
  container.innerHTML = list.map(commentItemHTML).join('');
  container.querySelectorAll('.cm-comment-like-btn').forEach((btn) => {
    btn.onclick = () => {
      btn.classList.toggle('on');
      showToast(btn.classList.contains('on') ? 'Đã thích bình luận' : 'Đã bỏ thích');
    };
  });
}

async function fetchComments(videoId) {
  // Guard: người dùng đã rời video này thì bỏ qua kết quả cũ
  if (!state.currentVideo || state.currentVideo.id !== videoId) return;
  const desktopList = $('#desktop-comments-list');
  const sheetList = $('#sheet-comments-list');
  desktopList.innerHTML = commentSkeletonHTML(3);
  sheetList.innerHTML = commentSkeletonHTML(3);
  try {
    const data = await fetchJSON(`/comments/${encodeURIComponent(videoId)}`, 10000);
    if (!state.currentVideo || state.currentVideo.id !== videoId) return;
    if (data.disabled) {
      desktopList.innerHTML = '<p class="cm-mono" style="padding:12px 4px">Bình luận đã bị tắt cho video này.</p>';
      sheetList.innerHTML = desktopList.innerHTML;
      $('#comment-preview').hidden = true;
      return;
    }
    const items = (data.comments || []).filter((c) => c.commentText);
    state.currentComments = items;
    const countText = data.commentCount ? `${formatCompactVN(data.commentCount)} bình luận` : `${items.length} bình luận`;
    $('#comment-count').textContent = countText;
    $('#sheet-comment-count').textContent = countText;

    renderCommentsHTML(items, desktopList);
    renderCommentsHTML(items, sheetList);

    const first = items[0];
    if (first) {
      const preview = $('#comment-preview');
      preview.style.removeProperty('--mini-y');
      preview.style.removeProperty('--mini-a');
      $('#preview-avatar').style.backgroundImage = `url('${initialsAvatar(first.uploaderName)}')`;
      $('#preview-count').textContent = countText;
      $('#preview-text').textContent = first.commentText || '';
      $('#comment-preview').hidden = false;
    } else {
      $('#comment-preview').hidden = true;
    }
  } catch (err) {
    console.warn('Bình luận:', err);
    if (!state.currentVideo || state.currentVideo.id !== videoId) return;
    const errHTML = `
      <div class="cm-empty" style="padding:2rem 1rem;margin-top:0">
        ${icon('inbox', 'icon icon-xl')}
        <p>Không tải được bình luận.</p>
        <button type="button" class="btn ghost sm cm-retry">${icon('refresh')}<span>Thử lại</span></button>
      </div>`;
    desktopList.innerHTML = errHTML;
    sheetList.innerHTML = errHTML;
    document.querySelectorAll('.cm-retry').forEach((btn) => {
      btn.onclick = () => fetchComments(videoId);
    });
    $('#comment-preview').hidden = true;
  }
}

function commentSkeletonHTML(count) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `
      <div class="comment-item">
        <div class="skeleton-avatar"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px">
          <div class="skeleton-line sub"></div>
          <div class="skeleton-line title"></div>
        </div>
      </div>`;
  }
  return html;
}

/* ────────────────────────────────────────────
   9. Hành động: thích / đăng ký / chia sẻ
   ──────────────────────────────────────────── */

function readLSMap(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}
function writeLSMap(key, map) {
  try { localStorage.setItem(key, JSON.stringify(map)); } catch { /* bỏ qua */ }
}

function getLikeState(videoId) {
  return readLSMap(LS_KEYS.likes)[videoId] || null;
}

function setVoteUI(stateName) {
  const likeBtn = $('#like-btn');
  const dislikeBtn = $('#dislike-btn');
  likeBtn.classList.toggle('on', stateName === 'like');
  dislikeBtn.classList.toggle('on', stateName === 'dislike');
}

function setSubscribeUI(subscribed) {
  const btn = $('#subscribe-btn');
  if (subscribed === null) {
    btn.disabled = true;
    btn.classList.remove('subscribed');
    btn.querySelector('span').textContent = 'Đăng ký';
    return;
  }
  btn.disabled = false;
  btn.classList.toggle('subscribed', subscribed);
  btn.querySelector('span').textContent = subscribed ? 'Đã đăng ký' : 'Đăng ký';
}

function isSubscribed(channelName) {
  return Boolean(readLSMap(LS_KEYS.subs)[channelName]);
}

function toggleLike() {
  const v = state.currentVideo;
  if (!v) return;
  const map = readLSMap(LS_KEYS.likes);
  const next = map[v.id] === 'like' ? null : 'like';
  if (next) map[v.id] = next; else delete map[v.id];
  writeLSMap(LS_KEYS.likes, map);
  setVoteUI(next);
  showToast(next === 'like' ? 'Đã thích video' : 'Đã bỏ thích');
}

function toggleDislike() {
  const v = state.currentVideo;
  if (!v) return;
  const map = readLSMap(LS_KEYS.likes);
  const next = map[v.id] === 'dislike' ? null : 'dislike';
  if (next) map[v.id] = next; else delete map[v.id];
  writeLSMap(LS_KEYS.likes, map);
  setVoteUI(next);
  showToast(next === 'dislike' ? 'Đã đánh dấu không thích' : 'Đã bỏ đánh dấu');
}

function toggleSubscribe() {
  const v = state.currentVideo;
  if (!v || !v.uploaderName) return;
  const map = readLSMap(LS_KEYS.subs);
  const subscribed = isSubscribed(v.uploaderName);
  if (subscribed) delete map[v.uploaderName]; else map[v.uploaderName] = 1;
  writeLSMap(LS_KEYS.subs, map);
  setSubscribeUI(!subscribed);
  showToast(subscribed ? 'Đã huỷ đăng ký kênh' : 'Đã đăng ký kênh');
}

async function shareCurrentVideo() {
  const v = state.currentVideo;
  if (!v) return;
  const url = `https://www.youtube.com/watch?v=${v.id}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: v.title, url });
      return;
    } catch { /* người dùng huỷ — rơi xuống sao chép */ }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('Đã sao chép liên kết video');
  } catch {
    showToast('Không thể sao chép liên kết');
  }
}

/* ────────────────────────────────────────────
   10. Sheet (drawer) & overlay
   ──────────────────────────────────────────── */

const SHEETS = [
  { sheet: 'comments-sheet', backdrop: 'comments-backdrop' },
  { sheet: 'options-sheet', backdrop: 'options-backdrop' },
];

function openSheet(sheetId, backdropId) {
  $(`#${backdropId}`).hidden = false;
  const sheet = $(`#${sheetId}`);
  sheet.hidden = false;
  // chạy lại animation trượt lên
  sheet.style.animation = 'none';
  void sheet.offsetWidth;
  sheet.style.animation = '';
}

function closeSheet(sheetId, backdropId) {
  $(`#${backdropId}`).hidden = true;
  $(`#${sheetId}`).hidden = true;
}

function closeAllSheets() {
  SHEETS.forEach(({ sheet, backdrop }) => closeSheet(sheet, backdrop));
}

function anySheetOpen() {
  return SHEETS.some(({ sheet }) => !$(`#${sheet}`).hidden);
}

/* ────────────────────────────────────────────
   11. Gắn sự kiện & khởi động
   ──────────────────────────────────────────── */

function bindEvents() {
  // Header
  $('#logo-btn').addEventListener('click', (e) => {
    e.preventDefault();
    if (state.mode === 'search') clearSearch();
    else if (state.watchVisible) goHome();
    else window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch($('#search-input').value);
    $('#search-input').blur();
  });
  $('#search-input').addEventListener('input', (e) => {
    $('#clear-search').hidden = e.target.value.length === 0;
  });
  $('#clear-search').addEventListener('click', () => {
    $('#search-input').value = '';
    $('#clear-search').hidden = true;
    if (state.mode === 'search') clearSearch();
    $('#search-input').focus();
  });

  // Tìm kiếm trên di động
  $('#mobile-search-toggle').addEventListener('click', () => {
    $('#mobile-search-overlay').hidden = false;
    $('#mobile-search-input').focus();
  });
  $('#mobile-search-back').addEventListener('click', () => {
    $('#mobile-search-overlay').hidden = true;
  });
  $('#mobile-search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#mobile-search-overlay').hidden = true;
    runSearch($('#mobile-search-input').value);
  });

  // Chủ đề & tuỳ chọn
  $('#theme-toggle').addEventListener('click', toggleTheme);
  $('#more-btn').addEventListener('click', () => {
    $('#about-instance').textContent = currentInstance.replace('https://', '');
    openSheet('options-sheet', 'options-backdrop');
  });
  $('#options-close').addEventListener('click', () => closeSheet('options-sheet', 'options-backdrop'));
  $('#options-backdrop').addEventListener('click', () => closeSheet('options-sheet', 'options-backdrop'));
  $('#option-theme').addEventListener('click', toggleTheme);
  $('#option-glass').addEventListener('click', toggleGlass);

  // Kết quả tìm kiếm
  $('#clear-results').addEventListener('click', clearSearch);
  $('#feed-retry').addEventListener('click', loadFeed);

  // Hành động trang xem
  $('#like-btn').addEventListener('click', toggleLike);
  $('#dislike-btn').addEventListener('click', toggleDislike);
  $('#subscribe-btn').addEventListener('click', toggleSubscribe);
  $('#share-btn').addEventListener('click', shareCurrentVideo);

  // Bình luận
  $('#comment-preview').addEventListener('click', () => openSheet('comments-sheet', 'comments-backdrop'));
  $('#comments-close').addEventListener('click', () => closeSheet('comments-sheet', 'comments-backdrop'));
  $('#comments-backdrop').addEventListener('click', () => closeSheet('comments-sheet', 'comments-backdrop'));

  // Esc đóng sheet / overlay
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (anySheetOpen()) { closeAllSheets(); return; }
    if (!$('#mobile-search-overlay').hidden) { $('#mobile-search-overlay').hidden = true; return; }
    if (state.watchVisible) goHome();
  });

  // Điều hướng trình duyệt (Back/Forward)
  window.addEventListener('popstate', () => {
    if (anySheetOpen()) { closeAllSheets(); return; }
    if (!$('#mobile-search-overlay').hidden) { $('#mobile-search-overlay').hidden = true; return; }
    if (state.watchVisible) goHome(false);
  });

  // Cuộn vô hạn
  window.addEventListener('scroll', () => {
    if (state.watchVisible) return;
    if (state.loading) return;
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - SCROLL_THRESHOLD_PX;
    if (nearBottom) loadMoreFeed();
  }, { passive: true });

  // Đồng bộ chủ đề theo hệ điều hành nếu người dùng chưa chọn thủ công
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem(LS_KEYS.theme); } catch { /* bỏ qua */ }
      if (saved !== 'light' && saved !== 'dark') applyTheme(e.matches ? 'dark' : 'light');
    });
  }
}

async function boot() {
  initTheme();
  initGlass();
  buildChips();
  bindEvents();
  $('#about-instance').textContent = currentInstance.replace('https://', '');

  // Glass Motion engine (đặc tả YTXTube): spring, pill, haptics, highlight
  initPressable();
  initChipsPill();
  initMiniDismiss();
  initGlassHighlights();
  syncChips({ pulse: false });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => window.ChipsPill && window.ChipsPill.relayout());
  }

  // Mở trực tiếp bằng liên kết ?v=VIDEO_ID
  const bootId = new URLSearchParams(location.search).get('v');
  if (bootId) {
    try {
      const data = await fetchJSON(`/streams/${encodeURIComponent(bootId)}`);
      const video = {
        id: bootId,
        title: data.title || '(không có tiêu đề)',
        uploaderName: data.uploader || 'Kênh chưa xác định',
        uploaderUrl: data.uploaderUrl || '',
        uploaderAvatar: initialsAvatar(data.uploader),
        thumbnail: thumbFor(bootId),
        duration: formatDuration(data.duration),
        isLive: data.livestream === true || parseInt(data.duration, 10) === -1,
        views: formatViews(data.views),
        uploaded: timeAgoVN(data.uploadDate),
      };
      await openWatch(video, { push: false });
      return;
    } catch (err) {
      console.warn('Không mở được video từ liên kết:', err);
      // Dọn tham số URL, dừng ở trang chủ và báo cho người dùng
      history.replaceState({ view: 'feed' }, '', '?');
      showToast('Không mở được video từ liên kết — đã về trang chủ');
    }
  }
  loadFeed();
}

/* ────────────────────────────────────────────
   12. GLASS MOTION — engine kính lỏng (đặc tả YTXTube)
   Spring 3.1 · Press 3.2 · DampedDrag 3.3 · Squash&Stretch 3.4
   InteractiveHighlight 3.5 · Tab pill 3.6 · Mini dismiss 9.5
   ──────────────────────────────────────────── */

const REDUCED_MOTION = window.matchMedia
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const clampGM = (x, a, b) => Math.min(b, Math.max(a, x));

// Haptics 3.8 — trình duyệt chỉ nhận pattern ms; amplitude là khái niệm Android
function haptic(ms) {
  if (navigator.vibrate) { try { navigator.vibrate(ms); } catch { /* bỏ qua */ } }
}

/* Spring engine 3.1: c = 2ζ√k (mass = 1), tích phân semi-implicit Euler,
   dt clamp ≤ 32ms. Reduced motion (R8) → snap tức thì, giữ trạng thái cuối. */
class Spring {
  constructor(zeta, k, x = 0, onFrame = null) {
    this.c = 2 * zeta * Math.sqrt(k);
    this.k = k;
    this.x = x;
    this.v = 0;
    this.target = x;
    this.onFrame = onFrame;
    this.t = 0;
    this.raf = 0;
  }
  set(x) {
    this.x = this.target = x;
    this.v = 0;
    if (this.onFrame) this.onFrame();
  }
  to(t) {
    if (REDUCED_MOTION) { this.set(t); return; }
    this.target = t;
    cancelAnimationFrame(this.raf);
    this.t = performance.now();
    const step = (now) => {
      // Timestamp rAF có thể NHỎ HƠN performance.now() lúc to() → dt âm phải chặn
      let dt = (now - this.t) / 1000;
      this.t = now;
      if (!(dt > 0)) dt = 0;
      if (dt > 0.032) dt = 0.032;
      // Substep ≤ 8ms: semi-implicit Euler chỉ ổn định khi ω·dt đủ nhỏ
      // (k=1000, dt=32ms → |λ|≈1.66 nổ số học; dt≤8ms → |λ|<0.85)
      const n = Math.max(1, Math.ceil(dt / 0.008));
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        this.v += (-this.k * (this.x - this.target) - this.c * this.v) * h;
        this.x += this.v * h;
      }
      if (this.onFrame) this.onFrame();
      if (Math.abs(this.x - this.target) > 1e-4 || Math.abs(this.v) > 1e-4) {
        this.raf = requestAnimationFrame(step);
      }
    };
    this.raf = requestAnimationFrame(step);
  }
}

/* Xấp xỉ spring bằng easing linear() — giữ overshoot, không tween phẳng (R5) */
function springEasing(zeta, k, steps = 16) {
  const c = 2 * zeta * Math.sqrt(k);
  let x = 0;
  let v = 0;
  const dt = 1 / 240;
  const frames = [];
  for (let i = 0; i < 720; i++) {
    v += (-k * x - c * v) * dt;
    x += v * dt;
    frames.push(x);
    if (i > 12 && Math.abs(x - 1) < 0.0005 && Math.abs(v) < 0.0005) break;
  }
  const stops = [];
  for (let s = 0; s <= steps; s++) {
    const idx = Math.min(frames.length - 1, Math.round((s / steps) * (frames.length - 1)));
    stops.push((clampGM(frames[idx], 0, 1.01) * 100).toFixed(1) + '%');
  }
  return `linear(${stops.join(', ')})`;
}

/* Press protocol 3.2: scale NGAY khi chạm, không ripple (R6), haptic KEYBOARD_TAP */
function initPressable() {
  try {
    if (CSS.supports('transition-timing-function', 'linear(0%, 100%)')) {
      document.documentElement.style.setProperty('--spring-press', springEasing(0.6, 1400));
      document.documentElement.style.setProperty('--t-press', '180ms');
    }
  } catch { /* giữ fallback cubic-bezier */ }

  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.pressable');
    if (!el || el.disabled) return;
    el.classList.add('is-pressed');
    haptic(10);
    let done = false;
    const up = () => {
      if (done) return;
      done = true;
      el.classList.remove('is-pressed');
    };
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  }, { passive: true });
}

/* Liquid Glass on/off — R9: tắt kính giữ nguyên bố cục, chỉ đổi vật liệu; persist */
function applyGlass(mode) {
  document.documentElement.dataset.glass = mode;
  const sw = $('#option-glass');
  if (sw) sw.setAttribute('aria-checked', mode === 'on' ? 'true' : 'false');
}

function initGlass() {
  let mode = 'on';
  try { mode = localStorage.getItem(LS_KEYS.glass) === 'off' ? 'off' : 'on'; } catch { /* bỏ qua */ }
  applyGlass(mode);
}

function toggleGlass() {
  const next = document.documentElement.dataset.glass === 'off' ? 'on' : 'off';
  applyGlass(next);
  try { localStorage.setItem(LS_KEYS.glass, next); } catch { /* bỏ qua */ }
  showToast(next === 'on' ? 'Đã bật Liquid Glass' : 'Đã tắt kính — nền đặc, bố cục giữ nguyên');
  haptic(12);
}

/* InteractiveHighlight 3.5 cho bề mặt kính: vệt sáng bám con trỏ, blend Plus */
function initGlassHighlights() {
  document.querySelectorAll('[data-hl]').forEach((el) => {
    const t = el.querySelector('.glass-hl-el');
    if (!t || el.dataset.hlInit) return;
    el.dataset.hlInit = '1';
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      t.style.setProperty('--hl-x', (e.clientX - r.left).toFixed(1) + 'px');
      t.style.setProperty('--hl-y', (e.clientY - r.top).toFixed(1) + 'px');
      t.style.setProperty('--hl-o', '1');
    }, { passive: true });
    el.addEventListener('pointerleave', () => t.style.setProperty('--hl-o', '0'));
  });
}

/* ── Tab pill choreography 3.6 + DampedDrag 3.3 + squash & stretch 3.4 ──
   5 spring đúng bảng 3.1: value(1,1000) · press(1,1000) · sx(0.6,250) ·
   sy(0.7,250) · hl(0.5,300). Không touch slop (9.0), settle-gate 2.5% (9.4). */
function initChipsPill() {
  const bar = $('#chips-bar');
  const track = $('#chips-track');
  const pill = $('#chip-pill');
  const hl = $('#pill-hl');
  if (!bar || !track || !pill || !hl || window.ChipsPill) return;

  let cells = [];
  let avgCell = 120;
  let trackW = 600;
  let settling = false;
  let settleTarget = 0;
  let suppressClick = false;
  const armSuppress = () => {
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 350);
  };

  const S = {
    value: new Spring(1.0, 1000, 0, render),
    press: new Spring(1.0, 1000, 0, render),
    sx: new Spring(0.6, 250, 1, render),
    sy: new Spring(0.7, 250, 1, render),
    hlx: new Spring(0.5, 300, 0, render),
    hly: new Spring(0.5, 300, 0, render),
    pulseT: 0,
  };

  function measure() {
    cells = [...track.querySelectorAll('.chip')];
    if (cells.length === 0) return;
    trackW = track.scrollWidth;
    avgCell = Math.max(60, trackW / cells.length);
    hl.style.setProperty('--pill-hl-r', Math.round(Math.min(avgCell, 44) * 1.5) + 'px');
  }

  function widthFor(x) {
    let best = cells[0];
    let bd = Infinity;
    for (const el of cells) {
      const d = Math.abs(el.offsetLeft - x);
      if (d < bd) { bd = d; best = el; }
    }
    return best ? best.offsetWidth : 80;
  }

  function render() {
    if (cells.length === 0) return;
    const p = clampGM(S.press.x, 0, 1);
    // 3.4: v = velocity/10 (chip/giây) · scaleX ÷ (1−v×0.75) · scaleY × (1−v×0.25) · clamp ±0.2
    const v = clampGM(S.value.v / avgCell / 10, -0.2, 0.2);
    const sx = S.sx.x / (1 - clampGM(v * 0.75, -0.2, 0.2));
    const sy = S.sy.x * (1 - clampGM(v * 0.25, -0.2, 0.2));
    pill.style.setProperty('--pill-x', S.value.x.toFixed(2) + 'px');
    pill.style.setProperty('--pill-sx', sx.toFixed(4));
    pill.style.setProperty('--pill-sy', sy.toFixed(4));
    pill.style.width = widthFor(S.value.target) + 'px';       // pill ôm chip đang đuổi
    // 3.6: blur tan khi giữ (8×(1−p)) · tint 0.12(1−p)+0.03p · highlight alpha p
    pill.style.setProperty('--pill-p', p.toFixed(3));
    pill.style.setProperty('--pill-blur', (8 * (1 - p)).toFixed(2) + 'px');
    hl.style.setProperty('--pill-hl-o', p.toFixed(3));
    hl.style.setProperty('--pill-hl-x', S.hlx.x.toFixed(1) + 'px');
    hl.style.setProperty('--pill-hl-y', S.hly.x.toFixed(1) + 'px');
    // 9.4 settle-gate: giữ trạng thái ép tới khi gần đích (2.5% range) rồi mới nhả
    if (settling && Math.abs(S.value.x - settleTarget) < trackW * 0.025) {
      settling = false;
      S.press.to(0);
      S.sx.to(1);
      S.sy.to(1);
    }
  }

  function tapPulse() {
    // 9.1 tap pulse: viên kính "hít vào–thở ra" 1 nhịp, không ripple
    S.press.to(1);
    S.sx.to(78 / 56);
    S.sy.to(78 / 56);
    clearTimeout(S.pulseT);
    S.pulseT = setTimeout(() => {
      S.press.to(0);
      S.sx.to(1);
      S.sy.to(1);
    }, 140);
  }

  function sync(idx, { pulse = true } = {}) {
    if (cells.length === 0) measure();
    if (!cells[idx]) idx = 0;
    if (pulse) tapPulse();
    S.value.to(cells[idx].offsetLeft);
    cells[idx].scrollIntoView({
      inline: 'center',
      block: 'nearest',
      behavior: REDUCED_MOTION ? 'auto' : 'smooth',
    });
  }

  function relayout() {
    measure();
    let idx = cells.findIndex((el) => el.classList.contains('active'));
    if (idx < 0) idx = 0;
    if (cells[idx]) S.value.set(cells[idx].offsetLeft);
  }

  function moveHl(e) {
    const r = pill.getBoundingClientRect();
    S.hlx.to(clampGM(e.clientX - r.left, 0, r.width));
    S.hly.to(clampGM(e.clientY - r.top, 0, r.height));
  }

  function edgeScroll(e) {
    const r = bar.getBoundingClientRect();
    const zone = 48;
    if (e.clientX < r.left + zone) bar.scrollLeft -= (1 - (e.clientX - r.left) / zone) * 14;
    else if (e.clientX > r.right - zone) bar.scrollLeft += (1 - (r.right - e.clientX) / zone) * 14;
  }

  let pid = null;
  let startX = 0;
  let startTargetPx = 0;
  let moved = 0;
  let dragging = false;
  let lastCross = -1;
  let downChip = null;

  bar.addEventListener('pointerdown', (e) => {
    downChip = e.target.closest('.chip');
    if (!downChip) return;
    pid = e.pointerId;
    try { bar.setPointerCapture(pid); } catch { /* bỏ qua */ }
    startX = e.clientX;
    startTargetPx = S.value.target;
    moved = 0;
    dragging = false;
    lastCross = Math.round(startTargetPx / avgCell);
    // press() NGAY LẬP TỨC khi ngón chạm — không touch slop (9.0)
    S.press.to(1);
    S.sx.to(78 / 56);
    S.sy.to(78 / 56);
    track.classList.add('is-held');
    haptic(18);                       // bắt đầu drag 18/170
    clearTimeout(S.pulseT);
    moveHl(e);
  });

  bar.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    if (!dragging && moved > 8) dragging = true;
    if (!dragging) { moveHl(e); return; }
    // 9.3: target bám ngón, CLAMP tại mép (px); value spring(1,1000) đuổi
    const targetPx = clampGM(startTargetPx + dx, 0, cells[cells.length - 1].offsetLeft);
    S.value.to(targetPx);
    const cross = Math.round(targetPx / avgCell);
    if (cross !== lastCross) { lastCross = cross; haptic(16); }  // vượt ranh giới 16/170
    // bar lệch theo ngón: 4px × sign × EaseOut(|f|) (3.6)
    const f = clampGM(dx / bar.clientWidth, -1, 1);
    const shift = 4 * Math.sign(f) * (1 - (1 - Math.abs(f)) ** 2);
    bar.style.setProperty('--panel-shift', shift.toFixed(2) + 'px');
    edgeScroll(e);
    moveHl(e);
  });

  const endDrag = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    track.classList.remove('is-held');
    bar.style.setProperty('--panel-shift', '0px');
    haptic(20);                       // thả tay chốt 20/190
    if (dragging) {
      armSuppress();
      dragging = false;
      // 9.4: chốt chip gần nhất, giữ ép tới khi gần đích (settle-gate)
      const idx = clampGM(Math.round(S.value.target / avgCell), 0, cells.length - 1);
      settling = true;
      settleTarget = cells[idx].offsetLeft;
      S.value.to(settleTarget);
      // Lưu ý: setPointerCapture khiến click thật nhắm vào bar —
      // nên chọn danh mục trực tiếp, không dựa vào click của chip
      selectCategory(CATEGORIES[idx]);
    } else {
      dragging = false;
      S.press.to(0);
      S.sx.to(1);
      S.sy.to(1);
      if (downChip) {
        // Tap không kéo: setPointerCapture cũng nuốt click của chip → tự chọn
        armSuppress();
        const idx = cells.indexOf(downChip);
        if (idx >= 0) selectCategory(CATEGORIES[idx]);
      }
    }
    downChip = null;
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
  bar.addEventListener('lostpointercapture', (e) => {
    if (e.pointerId === pid) endDrag(e);
  });

  // Sau cú kéo thật, bỏ nhấp chuột còn sót để không đổi chip 2 lần
  track.addEventListener('click', (e) => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
      suppressClick = false;
    }
  }, true);

  window.addEventListener('resize', relayout);
  window.ChipsPill = { sync, relayout };
  relayout();
}

/* ── Mini dismiss 9.5 (LiquidMiniPlayer): kéo xuống tự do (clamp ≥0),
      thả không đạt ngưỡng → snapTo(0) TỨC THÌ; vượt ngưỡng → bay 2.2×56dp
      tween(200, Emphasized) rồi tắt ── */
function initMiniDismiss() {
  const el = $('#comment-preview');
  if (!el || el.dataset.miniInit) return;
  el.dataset.miniInit = '1';

  let pid = null;
  let y0 = 0;
  let pull = 0;
  let moved = 0;
  let lastY = 0;
  let lastT = 0;
  let vel = 0;

  el.addEventListener('pointerdown', (e) => {
    pid = e.pointerId;
    try { el.setPointerCapture(pid); } catch { /* bỏ qua */ }
    y0 = e.clientY;
    lastY = y0;
    lastT = performance.now();
    pull = 0;
    moved = 0;
    vel = 0;
    el.style.transition = 'none';
  });

  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const now = performance.now();
    const dt = Math.max(1, now - lastT);
    vel = ((e.clientY - lastY) / dt) * 1000;      // px/s
    lastY = e.clientY;
    lastT = now;
    moved = Math.max(moved, Math.abs(e.clientY - y0));
    if (moved <= 6) return;
    pull = Math.max(0, e.clientY - y0);           // kéo lên bị CHẶN (clamp ≥ 0)
    el.style.setProperty('--mini-y', pull.toFixed(1) + 'px');
    el.style.setProperty('--mini-a', Math.max(0, 1 - pull / 90).toFixed(3));
  });

  const finish = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    el.style.transition = '';
    if (moved > 6 && (pull > 56 || vel > 800)) {
      const fly = el.animate(
        [
          { transform: `translateY(${pull.toFixed(1)}px)`, opacity: Math.max(0, 1 - pull / 90) },
          { transform: 'translateY(123px)', opacity: 0 },
        ],
        { duration: 200, easing: 'cubic-bezier(0.2, 0.9, 0.2, 1.0)' },
      );
      fly.onfinish = () => {
        el.hidden = true;
        el.style.removeProperty('--mini-y');
        el.style.removeProperty('--mini-a');
      };
    } else if (moved > 6) {
      // hard snap tức thì (không animation) theo 9.5
      el.style.removeProperty('--mini-y');
      el.style.removeProperty('--mini-a');
    }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
}

document.addEventListener('DOMContentLoaded', boot);
