/* ═════════════════════════════════════════════════════════════════════════
   NEON VOLT — VK Play billing / shop module
   Документация:
   https://documentation.vkplay.ru/f2p_vkp/f2pb_js_vkp
   https://documentation.vkplay.ru/f2p_vkp/f2pb_billing_vkp
   ═════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var ITEMS = [
    {
      id: 'neon_supporter',
      title: '⭐ Меценат',
      short: 'Неоновый меценат',
      desc: 'Золотой шлейф и значок поддержки в меню. Косметика, не влияет на результат.',
      prices: { RUB: 100, EUR: 3, USD: 3 }
    },
    {
      id: 'neon_revive',
      title: '💜 Второе дыхание',
      short: 'Второе дыхание',
      desc: '1 воскрешение в каждом забеге + золотой шлейф и значок. Поможет дотянуть до нового рекорда.',
      prices: { RUB: 300, EUR: 9, USD: 9 }
    },
    {
      id: 'neon_legend',
      title: '👑 Легенда трассы',
      short: 'Легенда трассы',
      desc: '2 воскрешения в забеге, фиолетовый скин и шлейф, значок легенды. Все привилегии предыдущих уровней.',
      prices: { RUB: 600, EUR: 18, USD: 18 }
    }
  ];

  var LS_ENTITLEMENTS = 'neonvolt.vkplay.entitlements';
  var LS_GMRID = 'neonvolt.vkplay.gmrid';

  var st = {
    appId: '',
    apiBase: '',
    clientIp: '',
    uid: '',
    currency: 'RUB',
    api: null,
    apiReady: false,
    loginStatus: null,
    authWaiters: [],
    serverItems: [],
    cachedItems: [],
    revivesLeft: 0,
    demo: /[?&]demo=1(?:[&#]|$)/.test(window.location.search),
    statusText: ''
  };

  function t(ru, en) {
    try {
      return typeof currentLang !== 'undefined' && currentLang === 'en' ? en : ru;
    } catch (e) {
      return ru;
    }
  }

  function readParams() {
    var q = new URLSearchParams(window.location.search);
    var meta = document.querySelector('meta[name="vkplay-gmid"]');
    st.appId = q.get('appid') || (meta && meta.getAttribute('content')) || '';
    if (st.appId === 'YOUR_GMRID') st.appId = '';
    if (!st.appId) {
      try { st.appId = localStorage.getItem(LS_GMRID) || ''; } catch (e) {}
    }
    if (st.appId) {
      try { localStorage.setItem(LS_GMRID, st.appId); } catch (e) {}
    }

    var apiMeta = document.querySelector('meta[name="vkplay-api-base"]');
    st.apiBase = ((apiMeta && apiMeta.getAttribute('content')) || '').replace(/\/+$/, '');
    if (st.apiBase.indexOf('YOUR_BACKEND') !== -1) st.apiBase = '';

    var cur = (q.get('currency') || 'RUB').toUpperCase();
    st.currency = (cur === 'RUB' || cur === 'EUR' || cur === 'USD') ? cur : 'RUB';
    st.uid = q.get('uid') || '';
  }

  function apiUrl(path) {
    return st.apiBase ? st.apiBase + path : path;
  }

  function readCache() {
    try {
      var raw = localStorage.getItem(LS_ENTITLEMENTS);
      var parsed = raw ? JSON.parse(raw) : [];
      st.cachedItems = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      st.cachedItems = [];
    }
  }

  function writeCache(items) {
    try { localStorage.setItem(LS_ENTITLEMENTS, JSON.stringify(items)); } catch (e) {}
  }

  function allItems() {
    var out = st.cachedItems.slice();
    st.serverItems.forEach(function (id) {
      if (out.indexOf(id) === -1) out.push(id);
    });
    if (st.demo) {
      ITEMS.forEach(function (item) {
        if (out.indexOf(item.id) === -1) out.push(item.id);
      });
    }
    return out;
  }

  function has(id) {
    return allItems().indexOf(id) !== -1;
  }

  function reviveLimit() {
    if (has('neon_legend')) return 2;
    if (has('neon_revive')) return 1;
    return 0;
  }

  function setStatus(text, isError) {
    st.statusText = text;
    var el = document.getElementById('shopStatus');
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? '#ff9ab0' : '#ffd166';
  }

  /* ─── VK Play JS API ───────────────────────────────────────────────── */

  function loadCoreScript() {
    if (!st.appId) {
      setStatus(t('Укажите GMRID проекта в meta-теге index.html.', 'Set your project GMRID in the index.html meta tag.'), true);
      return;
    }
    var src = '//vkplay.ru/app/' + encodeURIComponent(st.appId) + '/static/mailru.core.js';
    var s = document.createElement('script');
    s.src = location.protocol === 'https:' ? 'https:' + src : 'http:' + src;
    s.onload = connectApi;
    s.onerror = function () {
      setStatus(t('Не удалось загрузить VK Play JS API.', 'Could not load VK Play JS API.'), true);
    };
    document.head.appendChild(s);
  }

  function flushAuthWaiters(err) {
    var list = st.authWaiters.slice();
    st.authWaiters = [];
    list.forEach(function (w) {
      if (err) w.reject(err); else w.resolve();
    });
  }

  function onLoginStatus(status) {
    st.loginStatus = status && typeof status.loginStatus !== 'undefined' ? String(status.loginStatus) : '';
    if (st.loginStatus === '2' || st.loginStatus === '3') {
      flushAuthWaiters(null);
    }
    renderShop();
  }

  function connectApi() {
    if (typeof window.iframeApi !== 'function') {
      setStatus(t('Запустите игру через страницу VK Play — вне платформы покупки недоступны.',
        'Open the game from its VK Play page — purchases are unavailable outside the platform.'));
      return;
    }

    var callbacks = {
      appid: st.appId,
      getLoginStatusCallback: onLoginStatus,
      userInfoCallback: function (info) {
        if (info && info.uid) {
          st.uid = String(info.uid);
          fetchEntitlements();
          fetchScore();
        }
        renderShop();
      },
      userProfileCallback: function () {},
      registerUserCallback: function (info) {
        if (info && info.uid) st.uid = String(info.uid);
        if (st.api) st.api.getLoginStatus();
      },
      paymentReceivedCallback: function (data) {
        console.info('[billing] paymentReceived', data);
        if (data && data.uid) st.uid = String(data.uid);
        fetchEntitlements().then(function () {
          setStatus(t('Оплата прошла! Привилегии активированы.', 'Payment complete! Your perks are active.'));
        });
      },
      paymentWindowClosedCallback: function () {
        console.info('[billing] paymentWindowClosed');
        setStatus(t('Окно оплаты закрыто. Если оплату вы провели, обновите страницу.',
          'Payment window closed. Refresh the page if you have paid.'));
      },
      getAuthTokenCallback: function () {},
      paymentFrameUrlCallback: function () {},
      paymentFrameItem: function () {},
      getGameInventoryItems: function () {}
    };

    window.iframeApi(callbacks).then(function (api) {
      st.api = api;
      st.apiReady = true;
      api.getLoginStatus();
      api.userInfo();
      setStatus(t('Авторизуйтесь в VK Play, чтобы покупки были доступны.',
        'Sign in to VK Play to unlock purchases.'));
    }, function (err) {
      setStatus(t('Ошибка подключения к VK Play: ' + (err && err.message ? err.message : 'unknown'),
        'VK Play connection error: ' + (err && err.message ? err.message : 'unknown')), true);
    });
  }

  function waitForAuth() {
    if (!st.apiReady || !st.api) {
      return Promise.reject(new Error(t('VK Play API недоступен.', 'VK Play API is unavailable.')));
    }
    if (st.loginStatus === '2' || st.loginStatus === '3') return Promise.resolve();

    return new Promise(function (resolve, reject) {
      st.authWaiters.push({ resolve: resolve, reject: reject });
      if (st.loginStatus === '1') {
        st.api.registerUser();
      } else {
        st.api.authUser();
      }
      setTimeout(function () {
        var i = st.authWaiters.findIndex(function (w) { return w.resolve === resolve; });
        if (i !== -1) {
          st.authWaiters.splice(i, 1);
          reject(new Error(t('Авторизация не завершена.', 'Authorization was not completed.')));
        }
      }, 120000);
    });
  }

  function paymentCurrency() {
    return st.currency === 'EUR' || st.currency === 'USD' ? st.currency : 'RUB';
  }

  /* ─── Server: entitlements / score ─────────────────────────────────── */

  // IP нужен в merchant_param: платформа требует IPv4 покупателя (ошибка 2003).
  // Берём его со своего бэкенда, без сторонних сервисов.
  function fetchClientIp() {
    if (st.clientIp) return Promise.resolve(st.clientIp);
    return fetch(apiUrl('/api/client-ip'))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.status === 'ok' && data.ip) st.clientIp = data.ip;
        return st.clientIp;
      })
      .catch(function () { return st.clientIp; });
  }

  function fetchEntitlements() {
    if (!st.uid) return Promise.resolve();
    return fetch(apiUrl('/api/entitlements?uid=' + encodeURIComponent(st.uid)))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.status === 'ok' && Array.isArray(data.items)) {
          st.serverItems = data.items.filter(function (id) {
            return ITEMS.some(function (item) { return item.id === id; });
          });
          writeCache(allItems());
        }
        applyEntitlements();
      })
      .catch(function () { applyEntitlements(); });
  }

  function fetchScore() {
    if (!st.uid) return;
    // Рекорд хранится локально; серверный вызов ниже используется только если
    // вы развернули server.js и настроили маршрут /api/score.
    fetch(apiUrl('/api/score?uid=' + encodeURIComponent(st.uid)))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data && data.status === 'ok' && typeof data.score === 'number' && data.score > highscore) {
          highscore = data.score;
          saveHighscore();
          updateMenuBest();
        }
      })
      .catch(function () {});
  }

  function saveCloudScore(score) {
    if (!st.uid) return;
    fetch(apiUrl('/api/score?uid=' + encodeURIComponent(st.uid) + '&score=' + encodeURIComponent(score)), {
      method: 'POST'
    }).catch(function () {});
  }

  /* ─── UI ───────────────────────────────────────────────────────────── */

  function renderShop() {
    var list = document.getElementById('shopList');
    if (!list) return;
    var currency = paymentCurrency();
    list.innerHTML = '';

    ITEMS.forEach(function (item) {
      var owned = has(item.id);
      var price = item.prices[currency] || item.prices.RUB;
      var card = document.createElement('div');
      card.className = 'shop-item' + (owned ? ' owned' : '');

      var title = document.createElement('h3');
      title.textContent = item.title;
      card.appendChild(title);

      var desc = document.createElement('p');
      desc.textContent = item.desc + ' ';
      var priceSpan = document.createElement('span');
      priceSpan.className = 'price';
      priceSpan.textContent = price + ' ' + currency;
      desc.appendChild(priceSpan);
      card.appendChild(desc);

      var btn = document.createElement('button');
      btn.className = 'btn ' + (owned ? 'btn-ghost' : 'btn-shop');
      btn.textContent = owned
        ? t('✓ Активировано', '✓ Active')
        : t('Купить за ' + price + ' ' + currency, 'Buy for ' + price + ' ' + currency);
      btn.disabled = owned;
      btn.addEventListener('click', function () { buy(item.id); });
      card.appendChild(btn);

      list.appendChild(card);
    });

    if (st.demo) {
      var demoBtn = document.createElement('button');
      demoBtn.className = 'btn btn-ghost';
      demoBtn.style.marginTop = '1em';
      demoBtn.textContent = t('Демо: сбросить привилегии', 'Demo: reset perks');
      demoBtn.addEventListener('click', function () {
        st.demo = false;
        st.cachedItems = [];
        writeCache([]);
        applyEntitlements();
        renderShop();
      });
      list.appendChild(demoBtn);
    }

    applyEntitlements();
  }

  function applyEntitlements() {
    var badge = document.getElementById('supporterBadge');
    if (badge) {
      if (has('neon_legend')) badge.textContent = '👑 Легенда трассы';
      else if (has('neon_revive')) badge.textContent = '💜 Второе дыхание';
      else if (has('neon_supporter')) badge.textContent = '⭐ Меценат';
      else badge.textContent = '';
      badge.hidden = !badge.textContent;
    }

    var btn = document.getElementById('btnRevive');
    if (btn && document.getElementById('scrGameOver').classList.contains('active') &&
        !lastRunWasTutorial) {
      var left = reviveLimit();
      if (left > 0) {
        btn.style.display = 'flex';
        btn.textContent = '💜 Воскреснуть (' + left + ')';
      } else {
        btn.style.display = 'none';
      }
    }
  }

  function buy(itemId) {
    if (st.demo) {
      if (st.cachedItems.indexOf(itemId) === -1) st.cachedItems.push(itemId);
      writeCache(st.cachedItems);
      setStatus(t('Демо-режим: привилегия активирована.', 'Demo mode: perk activated.'));
      applyEntitlements();
      renderShop();
      return;
    }

    var item = ITEMS.filter(function (i) { return i.id === itemId; })[0];
    if (!item) return;

    if (!st.apiReady) {
      setStatus(t('Покупки доступны только на странице игры в VK Play.',
        'Purchases are only available on the game page in VK Play.'), true);
      return;
    }

    waitForAuth().then(function () {
      return fetchClientIp().then(function (ip) {
        var currency = paymentCurrency();
        var merchantParam = {
          uid: String(st.uid),
          amount: item.prices[currency] || item.prices.RUB,
          currency: currency,
          description: item.short,
          item_id: item.id,
          additional_param: 'neonvolt_' + Date.now()
        };
        if (ip) merchantParam.ip = ip;

        try {
          st.api.paymentFrame({ scenario: 'item', merchant_param: merchantParam });
          console.info('[billing] paymentFrame', merchantParam);
        } catch (e) {
          console.warn('[billing] paymentFrame failed', e);
          setStatus(t('Не удалось открыть окно оплаты.', 'Could not open the payment window.'), true);
          return;
        }
        setStatus(t('Открываем окно оплаты...', 'Opening the payment window...'));
      });
    }).catch(function (err) {
      setStatus(err && err.message ? err.message : t('Не удалось открыть оплату.', 'Could not open payment.'), true);
    });
  }

  function doRevive() {
    if (st.revivesLeft <= 0) return;
    var over = document.getElementById('scrGameOver');
    if (!over || !over.classList.contains('active')) return;

    st.revivesLeft--;

    gameOverTimer = null;
    over.classList.remove('active');
    document.getElementById('btnRevive').style.display = 'none';

    world.entities = world.entities.filter(function (e) {
      return e.type === 'coin' || e.x > player.x + 280;
    });
    world.particles.length = 0;
    world.trail.length = 0;
    world.popups.length = 0;

    player.vy = 0;
    player.onGround = true;
    player.feetY = GROUND_Y;
    player.h = CFG.standH;
    player.y = GROUND_Y - CFG.standH;
    player.jumpsLeft = 1;
    player.coyote = 0;
    player.duckAmt = 0;
    player.sq = 1;

    score = lastRunScore;
    invulnTimer = 2.4;
    isNewRecord = false;

    setState('play');
    updateHUDScore();
    if (Sound.enabled) {
      Sound.init();
      Sound.resume();
      Sound.startAmbient();
    }
  }

  function exitGame() {
    if (st.appId) {
      try { window.top.location.href = 'https://vkplay.ru/app/' + encodeURIComponent(st.appId); }
      catch (e) { window.location.href = 'https://vkplay.ru/app/' + encodeURIComponent(st.appId); }
    } else {
      try { window.close(); } catch (e) {}
    }
  }

  /* ─── Public API ───────────────────────────────────────────────────── */

  window.VKPlayBilling = {
    init: function () {
      readParams();
      readCache();
      applyEntitlements();
      renderShop();

      var shopBtn = document.getElementById('btnShop');
      var closeBtn = document.getElementById('btnShopClose');
      var reviveBtn = document.getElementById('btnRevive');

      if (shopBtn) {
        shopBtn.textContent = t('💎 Магазин поддержки', '💎 Support shop');
        shopBtn.addEventListener('click', function () {
          document.getElementById('scrMenu').classList.remove('active');
          document.getElementById('scrShop').classList.add('active');
          renderShop();
        });
      }
      if (closeBtn) {
        closeBtn.textContent = t('Вернуться в меню', 'Back to menu');
        closeBtn.addEventListener('click', function () {
          document.getElementById('scrShop').classList.remove('active');
          document.getElementById('scrMenu').classList.add('active');
        });
      }
      var shopTitle = document.getElementById('shopTitle');
      if (shopTitle) shopTitle.textContent = t('Магазин поддержки', 'Support shop');
      if (reviveBtn) reviveBtn.addEventListener('click', doRevive);

      loadCoreScript();
    },

    onGameOver: function (finalScore, wasTutorial) {
      lastRunScore = finalScore;
      st.revivesLeft = wasTutorial ? 0 : reviveLimit();
      var btn = document.getElementById('btnRevive');
      if (!btn) return;
      if (st.revivesLeft > 0 && !wasTutorial) {
        btn.style.display = 'flex';
        btn.textContent = '💜 Воскреснуть (' + st.revivesLeft + ')';
      } else {
        btn.style.display = 'none';
      }
    },

    saveCloudScore: saveCloudScore,
    buy: buy,
    exit: exitGame,

    getTrailColor: function () {
      if (has('neon_legend')) return '#c9a2ff';
      if (has('neon_revive')) return '#ff9ad8';
      if (has('neon_supporter')) return '#ffd166';
      return '#4de2c5';
    },

    getPlayerPalette: function () {
      if (has('neon_legend')) {
        return { dark: '#3b1a63', mid: '#8b5cf6', accent: '#c9a2ff', light: '#efe0ff' };
      }
      return {};
    }
  };
})();
