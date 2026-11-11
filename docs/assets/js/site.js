// Everything Studio — documentation site. Small helpers only: menu, copy buttons, picture viewer,
// the "you are here" mark in the page contents. No dependencies, no network requests.
(function () {
  'use strict';

  // ---- mobile menu ---------------------------------------------------------------------------
  var toggle = document.querySelector('.nav-toggle');
  var links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', function () {
      var open = links.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.addEventListener('click', function (e) {
      if (e.target.closest('a')) links.classList.remove('open');
    });
  }

  // ---- copy buttons on code blocks -----------------------------------------------------------
  document.querySelectorAll('.code').forEach(function (block) {
    var btn = block.querySelector('.copy');
    var pre = block.querySelector('pre');
    if (!btn || !pre) return;
    btn.addEventListener('click', function () {
      var text = pre.innerText.replace(/\n$/, '');
      var done = function () {
        btn.textContent = 'Copied';
        btn.classList.add('done');
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('done');
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
          done();
        } catch (err) {
          /* nothing to do */
        }
        document.body.removeChild(ta);
      }
    });
  });

  // ---- pictures open large ---------------------------------------------------------------------
  var shots = document.querySelectorAll('.shot');
  if (shots.length) {
    var box = document.createElement('div');
    box.className = 'lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Screenshot');
    box.innerHTML = '<button type="button">Close</button><div><img alt=""><p></p></div>';
    document.body.appendChild(box);
    var big = box.querySelector('img');
    var cap = box.querySelector('p');
    var last = null;
    var close = function () {
      box.classList.remove('open');
      big.removeAttribute('src');
      if (last) last.focus();
    };
    var open = function (fig) {
      var img = fig.querySelector('img');
      var c = fig.querySelector('figcaption');
      if (!img) return;
      last = fig;
      big.src = img.currentSrc || img.src;
      big.alt = img.alt;
      cap.textContent = c ? c.textContent : img.alt;
      box.classList.add('open');
      box.querySelector('button').focus();
    };
    box.addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && box.classList.contains('open')) close();
    });
    shots.forEach(function (fig) {
      fig.setAttribute('tabindex', '0');
      fig.setAttribute('role', 'button');
      fig.addEventListener('click', function () {
        open(fig);
      });
      fig.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(fig);
        }
      });
    });
  }

  // ---- contents of a documentation page: mark the section in view ---------------------------------
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll('.toc a[href^="#"]'));
  if (tocLinks.length && 'IntersectionObserver' in window) {
    var byId = {};
    tocLinks.forEach(function (a) {
      byId[a.getAttribute('href').slice(1)] = a;
    });
    var visible = new Set();
    var mark = function () {
      var first = null;
      tocLinks.forEach(function (a) {
        var id = a.getAttribute('href').slice(1);
        if (!first && visible.has(id)) first = a;
      });
      if (!first) return;
      tocLinks.forEach(function (a) {
        a.classList.toggle('on', a === first);
      });
    };
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) visible.add(en.target.id);
          else visible.delete(en.target.id);
        });
        mark();
      },
      { rootMargin: '-80px 0px -60% 0px' }
    );
    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) io.observe(el);
    });
  }
})();
