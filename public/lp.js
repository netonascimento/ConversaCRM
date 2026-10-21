/* Páginas por público (/mei, /advogados, /crm): cabeçalho, planos, indicação e medição própria.
   Mesma lógica da página inicial (landing.html); a página atual vai junto em cada evento. */
(function(){
  var doc = document.documentElement;
  var page = location.pathname.replace(/\/$/, '') || '/';
  document.getElementById('year').textContent = new Date().getFullYear();

  /* borda do cabeçalho ao rolar */
  var header = document.querySelector('.site-header');
  var onScroll = function(){ header.classList.toggle('scrolled', window.scrollY > 8); };
  window.addEventListener('scroll', onScroll, {passive:true}); onScroll();

  /* planos (só nas páginas que têm #plans) */
  var FALLBACK = {
    plans: [
      {id:'basico', label:'Básico', price_cents:4990, max_users:1, max_leads:50, max_searches:10, searches_period:'month', max_processes:10, description:'Para quem atende sozinho e está começando.'},
      {id:'essencial', label:'Essencial', price_cents:9990, max_users:2, max_leads:100, max_searches:30, searches_period:'month', max_processes:20, description:'Para quem atende sozinho ou em dupla.'},
      {id:'profissional', label:'Profissional', price_cents:24990, max_users:10, max_leads:null, max_searches:50, searches_period:'month', max_processes:null, description:'Para equipes com vários atendentes e profissionais.'}
    ],
    sales_whatsapp: '',
    allow_signup: true
  };
  var plansEl = document.getElementById('plans');
  var withProcesses = plansEl && plansEl.dataset.processes === '1';
  var SIGNUP = (document.querySelector('[data-signup]') || {}).getAttribute ? document.querySelector('[data-signup]').getAttribute('href') : '/app#cadastro';

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function money(cents){
    var v = (Number(cents) || 0) / 100;
    return v % 1 === 0 ? v.toLocaleString('pt-BR') : v.toLocaleString('pt-BR', {minimumFractionDigits:2, maximumFractionDigits:2});
  }
  function waLink(num, text){ return 'https://wa.me/' + String(num).replace(/\D/g,'') + '?text=' + encodeURIComponent(text); }
  function usersText(p, isTop){
    var n = Number(p.max_users) || 1;
    if (n === 1) return '1 usuário';
    return (isTop && n > 2 ? 'até ' : '') + n + ' usuários';
  }
  function leadsText(p){ return p.max_leads == null ? 'Ilimitados' : 'Até ' + Number(p.max_leads).toLocaleString('pt-BR'); }
  function processesText(p){ return p.max_processes == null ? 'Ilimitados' : 'Até ' + p.max_processes; }
  function searchesText(p){ return !p.max_searches ? 'Ilimitadas' : p.max_searches + (p.searches_period === 'month' ? ' por mês' : ' no teste'); }

  function render(info){
    var sales = (info && info.sales_whatsapp) ? String(info.sales_whatsapp).replace(/\D/g,'') : '';
    if (plansEl){
      var plans = (info && Array.isArray(info.plans) && info.plans.length) ? info.plans.slice() : FALLBACK.plans;
      plans.sort(function(a,b){ return (a.price_cents||0) - (b.price_cents||0); });
      var recIdx = -1;
      plans.forEach(function(p,i){ if (/profissional|pro\b/i.test((p.id||'') + ' ' + (p.label||''))) recIdx = i; });
      var maxUsers = Math.max.apply(null, plans.map(function(p){ return Number(p.max_users)||1; }));
      plansEl.innerHTML = plans.map(function(p, i){
        var rec = i === recIdx;
        var label = p.label || p.id;
        return '<article class="plan' + (rec ? ' rec' : '') + '" aria-label="Plano ' + esc(label) + '">' +
          '<h3>' + esc(label) + (rec ? '<span class="badge">Recomendado</span>' : '') + '</h3>' +
          '<div class="price"><span class="cur">R$</span><span class="val">' + money(p.price_cents) + '</span><span class="per">/mês</span></div>' +
          '<p class="desc">' + esc(p.description || '') + '</p>' +
          '<ul class="limits">' +
            '<li><span>Usuários</span><b>' + esc(usersText(p, (Number(p.max_users)||1) === maxUsers)) + '</b></li>' +
            (withProcesses ? '<li><span>Processos acompanhados</span><b>' + esc(processesText(p)) + '</b></li>' : '') +
            '<li><span>Leads</span><b>' + esc(leadsText(p)) + '</b></li>' +
            '<li><span>Buscas no Google Maps</span><b>' + esc(searchesText(p)) + '</b></li>' +
            '<li><span>Atendimento com IA</span><b>' + (p.ai === false ? 'Não incluso' : 'Incluso') + '</b></li>' +
          '</ul>' +
          '<a class="btn ' + (rec ? 'btn-primary' : 'btn-ghost') + '" data-signup data-plan="' + esc(label) + '" href="' + esc(SIGNUP) + '">Testar 7 dias grátis' +
          ' <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></a>' +
        '</article>';
      }).join('');
    }
    document.querySelectorAll('[data-sales]').forEach(function(a){
      if (sales){ a.href = waLink(sales, a.dataset.sales || 'Olá! Tenho uma dúvida sobre o Conversa CRM.'); a.target = '_blank'; a.rel = 'noopener'; }
      else { a.href = SIGNUP; }
    });
    if (info && info.allow_signup === false && sales){
      document.querySelectorAll('[data-signup]').forEach(function(a){
        a.href = waLink(sales, 'Olá! Quero começar a usar o Conversa CRM.'); a.target = '_blank'; a.rel = 'noopener';
      });
    }
  }

  render(FALLBACK);
  if (window.fetch && location.protocol !== 'file:'){
    fetch('/api/public/info', {headers:{'Accept':'application/json'}})
      .then(function(r){ if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function(info){ if (info) render(Array.isArray(info.plans) && info.plans.length ? info : Object.assign({}, info, {plans: FALLBACK.plans})); })
      .catch(function(){ /* os planos de reserva já estão na tela */ });
  }

  /* entrada suave: só esconde o que começa abaixo da dobra */
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && 'IntersectionObserver' in window){
    doc.classList.add('js');
    var els = [].slice.call(document.querySelectorAll('.reveal'));
    var vh = window.innerHeight;
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){ if (e.isIntersecting){ e.target.classList.remove('pending'); io.unobserve(e.target); } });
    }, {rootMargin:'0px 0px -6% 0px', threshold:0.08});
    els.forEach(function(el, i){
      if (el.getBoundingClientRect().top > vh){
        el.classList.add('pending');
        el.style.transitionDelay = ((i % 4) * 60) + 'ms';
        io.observe(el);
      }
    });
    window.addEventListener('beforeprint', function(){ els.forEach(function(el){ el.classList.remove('pending'); }); });
  }

  /* vídeo de 15 s: só toca quando aparece na tela; com "reduzir movimento" fica parado, com controles;
     se o arquivo não carregar (ex.: demonstração offline), a seção some */
  document.querySelectorAll('video[data-film]').forEach(function(v){
    var sec = v.closest('section');
    var source = v.querySelector('source');
    if (source) source.addEventListener('error', function(){ if (sec) sec.hidden = true; });
    if (reduce){ v.removeAttribute('autoplay'); v.pause(); v.controls = true; return; }
    if ('IntersectionObserver' in window){
      new IntersectionObserver(function(entries){
        entries.forEach(function(e){
          if (e.isIntersecting){ var p = v.play(); if (p && p.catch) p.catch(function(){}); }
          else v.pause();
        });
      }, {threshold:0.25}).observe(v);
    }
  });

  /* ---- indicação (?ref=CÓDIGO) e medição própria, sem cookies de terceiros e sem IP ---- */
  if (location.protocol === 'file:') return;
  function get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } }
  function set(k, v){ try { localStorage.setItem(k, v); } catch(e){} }
  function id(){ return (window.crypto && crypto.randomUUID ? crypto.randomUUID().replace(/-/g,'') : Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 32); }
  var qs = new URLSearchParams(location.search);
  var ref = (qs.get('ref') || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
  if (ref) set('cc_ref', ref);
  var vid = get('cc_vid') || id(); set('cc_vid', vid);
  var sid; try { sid = sessionStorage.getItem('cc_sid') || id(); sessionStorage.setItem('cc_sid', sid); } catch(e){ sid = id(); }
  var host = ''; try { host = document.referrer ? new URL(document.referrer).hostname.replace(/^www\./, '') : ''; } catch(e){}
  var src = qs.get('utm_source') || (ref ? 'indicação' : (host && host !== location.hostname ? host : 'direto'));
  if (!get('cc_src')) set('cc_src', src);
  var mobile = window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  var queue = [{ k: 'pageview' }];
  function push(k, n, val){ queue.push({ k: k, n: n == null ? null : String(n).slice(0, 120), val: val == null ? null : Math.round(val) }); }
  function flush(leaving){
    if (!queue.length) return;
    var body = JSON.stringify({ v: vid, s: sid, p: page, src: src, d: mobile ? 'mobile' : 'desktop', e: queue.splice(0, 60) });
    if (leaving && navigator.sendBeacon) navigator.sendBeacon('/api/t', new Blob([body], { type: 'application/json' }));
    else if (window.fetch) fetch('/api/t', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function(){});
  }

  if (ref && window.fetch){
    fetch('/api/public/referral/' + encodeURIComponent(ref)).then(function(r){ return r.json(); }).then(function(r){
      var el = document.getElementById('ref-strip');
      if (!r || !r.valid || !el) return;
      el.innerHTML = '🎁 <b>' + String(r.by).replace(/[<>&"]/g, '') + '</b> te indicou: você ganha <b>1 mês grátis</b> com o código ' + r.code + '.<a href="' + SIGNUP + '" data-signup data-track="Faixa de indicação">Começar agora</a>';
      el.hidden = false;
    }).catch(function(){});
  }

  var visibleMs = 0, since = document.hidden ? 0 : Date.now();
  function elapsed(){ return visibleMs + (since ? Date.now() - since : 0); }

  /* atenção por seção (o nome leva a página: "mei/como-funciona") */
  var secMs = {}, secSince = {};
  var prefix = page.slice(1) + '/';
  if ('IntersectionObserver' in window){
    var so = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        var k = prefix + e.target.id;
        if (e.isIntersecting && e.intersectionRatio >= 0.35){ if (!secSince[k] && !document.hidden) secSince[k] = Date.now(); }
        else if (secSince[k]){ secMs[k] = (secMs[k] || 0) + Date.now() - secSince[k]; secSince[k] = 0; }
      });
    }, { threshold: [0, 0.35, 0.6] });
    document.querySelectorAll('main section[id]').forEach(function(el){ so.observe(el); });
  }
  function closeSections(){ Object.keys(secSince).forEach(function(k){ if (secSince[k]){ secMs[k] = (secMs[k] || 0) + Date.now() - secSince[k]; secSince[k] = 0; } }); }

  var maxScroll = 0;
  window.addEventListener('scroll', function(){
    var h = document.documentElement.scrollHeight - window.innerHeight;
    if (h > 0) maxScroll = Math.max(maxScroll, Math.min(100, Math.round(window.scrollY / h * 100)));
  }, { passive: true });

  document.querySelectorAll('.faq details').forEach(function(d){
    d.addEventListener('toggle', function(){ if (d.open && d.dataset.seen !== '1'){ d.dataset.seen = '1'; var s = d.querySelector('summary'); push('faq', s ? s.textContent.trim() : ''); } });
  });
  document.addEventListener('click', function(e){
    var a = e.target.closest && e.target.closest('a, button');
    if (!a) return;
    if (a.dataset.plan) push('plan', a.dataset.plan);
    var name = a.dataset.track || (a.hasAttribute('data-signup') ? 'Testar grátis' + (a.dataset.plan ? ' (plano ' + a.dataset.plan + ')' : '') : (a.getAttribute('href') === '/app' ? 'Entrar' : null));
    if (name) push('cta', page + ' · ' + name);
    if (a.hasAttribute('data-signup') || a.getAttribute('href') === '/app') flush(true);
  }, true);

  function summary(){
    closeSections();
    Object.keys(secMs).forEach(function(k){ if (secMs[k] >= 500) push('section', k, secMs[k]); secMs[k] = 0; });
    push('time', null, elapsed());
    if (maxScroll) push('scroll', null, maxScroll);
  }
  document.addEventListener('visibilitychange', function(){
    if (document.hidden){ if (since){ visibleMs += Date.now() - since; since = 0; } summary(); flush(true); }
    else { since = Date.now(); }
  });
  window.addEventListener('pagehide', function(){ summary(); flush(true); });
  setInterval(function(){ if (!document.hidden){ summary(); flush(false); } }, 20000);
  setTimeout(function(){ flush(false); }, 1500);
})();
