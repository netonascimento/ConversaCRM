/* Medição de anúncios: Google Analytics 4, Google Ads e Pixel da Meta.
   Só carrega no site publicado (não em localhost) e só depois que a pessoa aceita os cookies (LGPD).
   Os IDs vêm de /api/public/info (variáveis GA4_ID, GOOGLE_ADS_ID, GOOGLE_ADS_SIGNUP_LABEL e META_PIXEL_ID).
   Eventos: window.cvTrack('signup', { plan }) no cadastro do teste; 'begin_checkout' e 'purchase' na assinatura
   (app.js, tela Assinatura); cliques em WhatsApp de vendas viram 'lead' sozinhos. */
(function(){
  var KEY = 'cv_consent';
  var ids = null, ready = false, queue = [];
  var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  function getConsent(){ try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function setConsent(v){ try { localStorage.setItem(KEY, v); } catch (e) {} }

  window.cvTrack = function(name, params){
    if (ready) send(name, params || {});
    else if (queue.length < 20) queue.push([name, params || {}]);
  };

  function load(src){
    var s = document.createElement('script'); s.async = true; s.src = src;
    document.head.appendChild(s);
  }

  function start(){
    if (ready || !ids) return;
    if (ids.ga4 || ids.google_ads){
      window.dataLayer = window.dataLayer || [];
      window.gtag = function(){ window.dataLayer.push(arguments); };
      window.gtag('consent', 'default', { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' });
      window.gtag('js', new Date());
      if (ids.ga4) window.gtag('config', ids.ga4);
      if (ids.google_ads) window.gtag('config', ids.google_ads);
      load('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(ids.ga4 || ids.google_ads));
    }
    if (ids.meta_pixel){
      /* trecho oficial do Pixel da Meta, sem o <noscript> */
      var n = window.fbq = function(){ n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
      if (!window._fbq) window._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      load('https://connect.facebook.net/en_US/fbevents.js');
      window.fbq('init', ids.meta_pixel);
      window.fbq('track', 'PageView');
    }
    ready = true;
    queue.splice(0).forEach(function(e){ send(e[0], e[1]); });
  }

  function send(name, p){
    var gt = window.gtag, fb = window.fbq;
    if (name === 'signup'){
      if (gt) gt('event', 'sign_up', { method: 'site', plan: p.plan || '' });
      if (gt && ids.google_ads && ids.google_ads_signup_label) gt('event', 'conversion', { send_to: ids.google_ads + '/' + ids.google_ads_signup_label });
      if (fb) fb('track', 'CompleteRegistration', { content_name: p.plan || '' });
    } else if (name === 'lead'){
      if (gt) gt('event', 'generate_lead', { source: p.source || '' });
      if (fb) fb('track', 'Lead');
    } else if (name === 'begin_checkout' || name === 'purchase'){
      /* assinatura: início do pagamento (botão do plano) e pagamento confirmado pelo Stripe */
      var item = { item_id: p.plan || '', item_name: p.label || p.plan || '', price: p.value || 0, quantity: 1 };
      var money = { currency: 'BRL', value: p.value || 0 };
      if (name === 'begin_checkout'){
        if (gt) gt('event', 'begin_checkout', { currency: 'BRL', value: money.value, payment_type: p.method || '', items: [item] });
        if (fb) fb('track', 'InitiateCheckout', { currency: 'BRL', value: money.value, content_ids: [item.item_id], content_name: item.item_name });
      } else {
        if (gt) gt('event', 'purchase', { transaction_id: p.id || '', currency: 'BRL', value: money.value, payment_type: p.method || '', items: [item] });
        if (fb) fb('track', 'Subscribe', { currency: 'BRL', value: money.value, predicted_ltv: Math.round(money.value * 1200) / 100, content_name: item.item_name }, p.id ? { eventID: 'sub-' + p.id } : undefined);
      }
    }
  }

  /* clique para falar com vendas no WhatsApp = lead */
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a[data-sales], a[href*="wa.me/"]');
    if (a) window.cvTrack('lead', { source: a.getAttribute('data-track') || 'whatsapp' });
  }, true);

  function banner(){
    var box = document.createElement('div');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Aviso de cookies');
    box.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:560px;margin:0 auto;'
      + 'background:var(--surface,#fffdf8);color:var(--ink,#10231a);border:1px solid var(--line,rgba(16,35,26,.12));'
      + 'border-radius:16px;box-shadow:0 24px 48px -28px rgba(16,35,26,.4);padding:16px 18px;'
      + 'font:14px/1.5 var(--font-sans,system-ui,sans-serif);display:flex;flex-wrap:wrap;gap:12px;align-items:center';
    box.innerHTML = '<span style="flex:1 1 260px">Usamos cookies do Google e da Meta para medir a visita e melhorar nossos anúncios. Você pode recusar sem perder nada do site.</span>'
      + '<span style="display:flex;gap:8px">'
      + '<button type="button" data-c="denied" style="height:38px;padding:0 14px;border-radius:999px;border:1px solid var(--line,rgba(16,35,26,.2));background:transparent;color:inherit;font:inherit;cursor:pointer">Recusar</button>'
      + '<button type="button" data-c="granted" style="height:38px;padding:0 16px;border-radius:999px;border:1px solid var(--green-800,#14532d);background:var(--green-800,#14532d);color:#f7f5ef;font:inherit;font-weight:500;cursor:pointer">Aceitar</button>'
      + '</span>';
    box.addEventListener('click', function(e){
      var c = e.target.getAttribute && e.target.getAttribute('data-c');
      if (!c) return;
      setConsent(c);
      box.remove();
      if (c === 'granted') start();
    });
    document.body.appendChild(box);
  }

  if (local || !window.fetch) return;
  fetch('/api/public/info', { headers: { Accept: 'application/json' } })
    .then(function(r){ return r.json(); })
    .then(function(info){
      var t = info && info.tracking;
      if (!t || !(t.ga4 || t.google_ads || t.meta_pixel)) return;
      ids = t;
      var c = getConsent();
      if (c === 'granted') start();
      else if (c !== 'denied') banner();
    })
    .catch(function(){});
})();
