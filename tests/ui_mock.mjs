import { chromium } from 'playwright'
import fs from 'node:fs'
const dir = 'D:/Project/udemy-thai-learning-kit/extension/'
const js = fs.readFileSync(dir + 'content.js', 'utf8')
const grab = (re, name) => { const m = js.match(re); if (!m) throw new Error(name + ' not found'); return m[0] }
const place = grab(/let placeQueued = false;[\s\S]*?\n  }\n\n  function renderStatus/, 'place').replace(/\n  function renderStatus$/, '')
const dock = grab(/function dockButton\(button\) \{[\s\S]*?\n  \}\n\n  function panelEl/, 'dock').replace(/\n  function panelEl$/, '')
const btnHtml = grab(/button\.innerHTML =[\s\S]*?<\/i>';/, 'btn')
const menuHtml = grab(/el\.innerHTML =\n      '<div class="udth-menu-head">[\s\S]*?udth-panel-note"><\/div>';/, 'menu')
const css = fs.readFileSync(dir + 'overlay.css', 'utf8')
const page = `<!doctype html><meta charset=utf-8><style>${css}
body{margin:0;background:#111;font-family:Arial}
#player{position:relative;width:1100px;height:420px;background:radial-gradient(circle at 50% 30%,#2b2b3a,#050508);overflow:hidden}
#scrub{position:absolute;left:16px;right:16px;bottom:60px;height:4px;background:#a435f0}
#bar{position:absolute;left:0;right:0;bottom:0;height:56px;display:flex;align-items:center;gap:0;padding:0 12px;color:#fff;background:linear-gradient(transparent,#000a)}
#bar .sp{flex:1}
.nat{width:40px;height:40px;border:0;background:transparent;color:#fff;font-size:20px;cursor:pointer;border-radius:8px}.nat:hover{background:#fff2}
</style>
<div id=player><video></video><div id=scrub></div>
<div id=bar data-purpose="video-control-bar"><button class=nat>▶</button><span class=sp></span>
<div><button class=nat data-purpose="transcript-toggle">📄</button></div>
<div><button class=nat data-purpose="captions-dropdown-button" aria-label="Captions">CC</button></div>
<div><button class=nat data-purpose="settings-button" aria-label="Settings">⚙</button></div>
<div><button class=nat data-purpose="fullscreen-button" aria-label="Fullscreen">⛶</button></div></div></div>
<script>
const log=()=>{};
const state={overlay:null,video:document.querySelector('video'),line:null};
const site={controlBar:()=>document.querySelector('#bar')};
const panel={el:null,button:null,open:true};
${place}
${dock}
const host=document.querySelector('#player');
const button=document.createElement('button');button.type='button';button.className='udth-pill';
${btnHtml}
button.classList.add('udth-pill-floating');host.appendChild(button);
const el=document.createElement('div');el.className='udth-menu';
${menuHtml}
host.appendChild(el);panel.el=el;panel.button=button;
el.querySelector('[data-udth=subs]').textContent='ซับไทย · เปิด';el.querySelector('[data-udth=subs]').classList.add('udth-chip-on');
el.querySelector('[data-udth=dub]').textContent='พากย์เสียง · ปิด';
for(const k of ['dubVol','srcVol','rate'])el.querySelector('[data-udth='+k+']').value=k==='rate'?1.6:(k==='dubVol'?1:0.15);
el.querySelector('[data-udth=dubVolOut]').value='100%';el.querySelector('[data-udth=srcVolOut]').value='15%';el.querySelector('[data-udth=rateOut]').value='1.60x';
el.querySelector('[data-udth=engine]').innerHTML='<option>Google Chirp 3 HD</option>';el.querySelector('[data-udth=voice]').innerHTML='<option>Gacrux — หญิง</option>';
const o=document.createElement('div');o.className='udth-overlay';const l=document.createElement('div');l.className='udth-line';o.appendChild(l);host.appendChild(o);state.overlay=o;state.line=l;
l.innerHTML='<div class="udth-en">Hey guys what\\'s up, I welcome you to another tutorial on this section where we are covering</div><div class="udth-th" lang="th">สวัสดีครับทุกคน ยินดีต้อนรับสู่ Tutorial (บทเรียนแนะนำทีละขั้นตอน) อีกตอนในหมวดนี้ที่เรากำลังเรียน</div>';
window.docked=dockButton(button);button.classList.add('udth-pill-on');
placeOverlay();
</script>`
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1100, height: 420 } })
const errs = []; p.on('pageerror', (e) => errs.push(e.message))
await p.setContent(page, { waitUntil: 'load' }); await p.waitForTimeout(500)
const r = await p.evaluate(() => {
  const bt = document.querySelector('.udth-pill'), bar = document.querySelector('#bar'), set = document.querySelector('[data-purpose=settings-button]')
  const m = document.querySelector('.udth-menu').getBoundingClientRect(), pl = document.querySelector('#player').getBoundingClientRect()
  return { docked: window.docked, parentIsBarChild: bt.parentElement === bar, nextIsSettingsWrapper: bt.nextElementSibling === set.parentElement, floating: bt.classList.contains('udth-pill-floating'), btnBox: Math.round(bt.getBoundingClientRect().width) + 'x' + Math.round(bt.getBoundingClientRect().height), menuTopInPlayer: Math.round(m.top - pl.top), menuBottomGapToBar: Math.round(document.querySelector('#bar').getBoundingClientRect().top - m.bottom) }
})
console.log(JSON.stringify(r), 'errs', errs)
await p.screenshot({ path: 'C:/Users/ADMINI~1/AppData/Local/Temp/redesign.png' })
await b.close()
