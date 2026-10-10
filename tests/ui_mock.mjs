import { chromium } from 'playwright'
import fs from 'node:fs'
const dir = 'D:/Project/udemy-thai-learning-kit/extension/'
const js = fs.readFileSync(dir + 'content.js', 'utf8')
const grab = (re, name) => { const m = js.match(re); if (!m) throw new Error(name + ' not found'); return m[0] }
const place = grab(/const UI = \{ lastMove: 0, timer: null \};[\s\S]*?\n  function renderStatus/, 'place').replace(/\n  function renderStatus$/, '')
const dock = grab(/function dockButton\(button\) \{[\s\S]*?\n  \}\n\n  function panelEl/, 'dock').replace(/\n  function panelEl$/, '')
const btnHtml = grab(/button\.innerHTML =[\s\S]*?<\/i>';/, 'btn')
const menuHtml = grab(/const version = \(\(\) => \{[\s\S]*?udth-panel-note"><\/div>';/, 'menu')
const css = fs.readFileSync(dir + 'overlay.css', 'utf8')
const manifestVersion = JSON.parse(fs.readFileSync(dir + 'manifest.json', 'utf8')).version
const page = `<!doctype html><meta charset=utf-8><style>${css}
body{margin:0;background:#111;font-family:Arial}
#player{position:relative;width:1100px;height:520px;background:linear-gradient(180deg,#f4f4f6,#d8dae0);overflow:hidden}
#code{position:absolute;left:150px;top:30px;font:26px/1.6 Consolas,monospace;color:#223}
#scrub{position:absolute;left:16px;right:16px;bottom:60px;height:4px;background:#a435f0}
#bar{position:absolute;left:0;right:0;bottom:0;height:56px;display:flex;align-items:center;padding:0 12px;color:#fff;background:linear-gradient(transparent,#000c)}
#bar .sp{flex:1}
.nat{width:40px;height:40px;border:0;background:transparent;color:#fff;font-size:20px;cursor:pointer;border-radius:8px}.nat:hover{background:#fff2}
</style>
<div id=player><video></video><pre id=code>switch(x) {\\n  case 'value1':\\n    ....\\n    [break]\\n  default:\\n    ....\\n}</pre><div id=scrub></div>
<div id=bar data-purpose="video-control-bar"><button class=nat>▶</button><span class=sp></span>
<div><button class=nat data-purpose="transcript-toggle">📄</button></div>
<div><button class=nat data-purpose="captions-dropdown-button" aria-label="Captions">CC</button></div>
<div><button class=nat data-purpose="settings-button" aria-label="Settings">⚙</button></div>
<div><button class=nat data-purpose="fullscreen-toggle" aria-label="Fullscreen">⛶</button></div></div></div>
<script>
const log=()=>{};
window.chrome={runtime:{getManifest:()=>({version:'${manifestVersion}'})}};
const state={overlay:null,video:document.querySelector('video'),line:null};
Object.defineProperty(state.video,'paused',{get:()=>false});
const site={controlBar:()=>document.querySelector('#bar')};
const panel={el:null,button:null,open:false};
${place}
${dock}
const host=document.querySelector('#player');
const button=document.createElement('button');button.type='button';button.className='udth-pill';
${btnHtml}
button.classList.add('udth-pill-floating');host.appendChild(button);
const el=document.createElement('div');el.className='udth-menu';el.hidden=true;
${menuHtml}
host.appendChild(el);panel.el=el;panel.button=button;
el.querySelector('[data-udth=mode][data-val=both]').classList.add('udth-seg-on');el.querySelector('[data-udth=size][data-val=m]').classList.add('udth-seg-on');
for(const k of ['dubVol','srcVol','rate'])el.querySelector('[data-udth='+k+']').value=k==='rate'?1.6:(k==='dubVol'?1:0.15);
el.querySelector('[data-udth=dubVolOut]').value='100%';el.querySelector('[data-udth=srcVolOut]').value='15%';el.querySelector('[data-udth=rateOut]').value='1.60x';
el.querySelector('[data-udth=engine]').innerHTML='<option>Google Chirp 3 HD</option>';el.querySelector('[data-udth=voice]').innerHTML='<option>Gacrux — หญิง</option>';
const o=document.createElement('div');o.className='udth-overlay';o.dataset.size='m';const l=document.createElement('div');l.className='udth-line';o.appendChild(l);host.appendChild(o);state.overlay=o;state.line=l;
l.innerHTML='<div class="udth-en">Hey guys what\\'s up, I welcome you to another tutorial on this section where we are covering</div><div class="udth-th" lang="th"><span>สวัสดีครับทุกคน ยินดีต้อนรับสู่ Tutorial (บทเรียนแนะนำทีละขั้นตอน) อีกตอนในหมวดนี้ที่เรากำลังเรียน</span></div>';
window.docked=dockButton(button);button.classList.add('udth-pill-on');
host.addEventListener('mousemove',onPointerActivity);
window.openMenu=()=>{panel.open=true;el.hidden=false;placeOverlay()};
</script>`
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1100, height: 520 } })
const errs = []; p.on('pageerror', (e) => errs.push(e.message))
await p.setContent(page, { waitUntil: 'load' })
const bottoms = () => p.evaluate(() => ({ bottom: document.querySelector('.udth-overlay').style.bottom, raised: document.querySelector('.udth-overlay').classList.contains('udth-raised') }))
await p.mouse.move(500, 300); await p.waitForTimeout(300)
const shown = await bottoms(); await p.screenshot({ path: 'C:/Users/ADMINI~1/AppData/Local/Temp/rd_controls.png' })
await p.waitForTimeout(3300)
const hidden = await bottoms(); await p.waitForTimeout(300); await p.screenshot({ path: 'C:/Users/ADMINI~1/AppData/Local/Temp/rd_idle.png' })
await p.mouse.move(520, 310); await p.waitForTimeout(300)
await p.evaluate(() => window.openMenu()); await p.waitForTimeout(400)
await p.screenshot({ path: 'C:/Users/ADMINI~1/AppData/Local/Temp/rd_menu.png' })
const r = await p.evaluate(() => {
  const m = document.querySelector('.udth-menu').getBoundingClientRect(), pl = document.querySelector('#player').getBoundingClientRect(), bt = document.querySelector('.udth-pill')
  return { docked: window.docked, inBar: bt.parentElement === document.querySelector('#bar'), btn: Math.round(bt.getBoundingClientRect().width) + 'x' + Math.round(bt.getBoundingClientRect().height), menuTop: Math.round(m.top - pl.top), menuBottomGap: Math.round(document.querySelector('#bar').getBoundingClientRect().top - m.bottom), ver: document.querySelector('.udth-ver').textContent }
})
console.log('controls shown:', JSON.stringify(shown), '| idle:', JSON.stringify(hidden)); console.log(JSON.stringify(r), 'errs', errs)
await b.close()
