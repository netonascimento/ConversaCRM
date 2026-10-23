/* Botão flutuante "Falar no WhatsApp" das páginas públicas (início, páginas por público e blog).
   O número é o WhatsApp de vendas (SALES_WHATSAPP, via /api/public/info); sem ele, o botão não aparece.
   A mensagem inicial muda conforme a página. O clique conta como lead em track.js (link wa.me)
   e como CTA na medição própria (data-track). */
(function(){
  if (!window.fetch || document.querySelector('.wa-float')) return;
  var page = location.pathname.replace(/\/$/, '') || '/';
  var TEXTS = {
    '/clinicas': 'Olá! Tenho uma clínica e quero saber como o Conversa CRM atende e agenda pelo WhatsApp.',
    '/advogados': 'Olá! Sou advogado(a) e quero saber mais sobre o Conversa CRM.',
    '/mei': 'Olá! Sou MEI e quero saber mais sobre o Conversa CRM.',
    '/crm': 'Olá! Quero saber mais sobre o CRM e o funil do Conversa CRM.'
  };
  var text = TEXTS[page] || (page.indexOf('/blog') === 0 ? 'Olá! Li o blog do Conversa CRM e tenho uma dúvida.' : 'Olá! Quero saber mais sobre o Conversa CRM.');

  var css = '.wa-float{position:fixed;right:20px;bottom:20px;z-index:9990;display:inline-flex;align-items:center;gap:10px;'
    + 'height:52px;padding:0 20px 0 16px;border-radius:999px;background:var(--green-800,#14532d);color:#f7f5ef;'
    + 'font:500 15px/1 var(--font-sans,"Geist",system-ui,sans-serif);text-decoration:none;'
    + 'box-shadow:0 1px 0 rgba(16,35,26,.08),0 18px 36px -18px rgba(16,35,26,.55);'
    + 'transition:transform .2s ease,background-color .2s ease;animation:wa-in .4s ease .6s both}'
    + '.wa-float:hover{background:var(--green-900,#0f3f22);transform:translateY(-2px)}'
    + '.wa-float:focus-visible{outline:2px solid var(--green-600,#1f7a45);outline-offset:3px}'
    + '.wa-float svg{width:24px;height:24px;flex:none}'
    + '@keyframes wa-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}'
    + '@media (max-width:760px){.wa-float{right:16px;bottom:16px;width:56px;height:56px;padding:0;justify-content:center}.wa-float span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}}'
    + '@media (prefers-reduced-motion:reduce){.wa-float{animation:none;transition:none}.wa-float:hover{transform:none}}'
    + '@media print{.wa-float{display:none}}';

  fetch('/api/public/info', { headers: { Accept: 'application/json' } })
    .then(function(r){ return r.json(); })
    .then(function(info){
      var num = info && info.sales_whatsapp ? String(info.sales_whatsapp).replace(/\D/g, '') : '';
      if (!num) return;
      var style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
      var a = document.createElement('a');
      a.className = 'wa-float';
      a.href = 'https://wa.me/' + num + '?text=' + encodeURIComponent(text);
      a.target = '_blank';
      a.rel = 'noopener';
      a.setAttribute('data-track', 'WhatsApp (botão flutuante)');
      a.setAttribute('aria-label', 'Falar com a gente no WhatsApp');
      a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 18.5l1.1-3.3A7.5 7.5 0 1 1 9 18.1L5 18.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>'
        + '<path d="M9.4 8.9c.2-.5.5-.5.7-.5h.5c.2 0 .4 0 .5.4l.6 1.4c.1.2 0 .4-.1.6l-.4.5c-.1.1-.1.3 0 .5.5.9 1.2 1.6 2.1 2.1.2.1.4.1.5 0l.5-.5c.2-.2.4-.2.6-.1l1.4.6c.3.1.4.3.4.5v.5c0 .3-.1.6-.6.8-.5.3-1.5.4-3-.3-1.6-.8-2.8-2.1-3.5-3.5-.6-1.4-.4-2.4-.2-2.9z" fill="currentColor"/></svg>'
        + '<span>Falar no WhatsApp</span>';
      document.body.appendChild(a);
    })
    .catch(function(){});
})();
