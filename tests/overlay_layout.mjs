import { chromium } from 'playwright'
import fs from 'node:fs'
const dir = 'D:/Project/udemy-thai-learning-kit/extension/'
const js = fs.readFileSync(dir + 'content.js', 'utf8')
const m = js.match(/let placeQueued = false;[\s\S]*?\n  }\n\n  function renderStatus/)
if (!m) throw new Error('placeOverlay not found')
const fn = m[0].replace(/\n  function renderStatus$/, '')
const css = fs.readFileSync(dir + 'overlay.css', 'utf8')
const html = (h, barH) => `<!doctype html><meta charset=utf-8><style>${css}
body{margin:0;background:#222;font-family:Arial}
#player{position:relative;width:1000px;height:${h}px;background:#000;overflow:hidden}
#bar{position:absolute;left:0;right:0;bottom:0;height:${barH}px;background:#333;color:#aaa}
#scrub{position:absolute;left:0;right:0;bottom:${barH}px;height:4px;background:#a435f0}
</style><div id=player><video></video><div id=scrub></div><div id=bar data-purpose="video-control-bar">controls</div></div>
<script>
const state={overlay:null,video:document.querySelector('video'),line:null};
const site={controlBar:()=>document.querySelector('#bar')};
${fn}
const o=document.createElement('div');o.className='udth-overlay';const l=document.createElement('div');l.className='udth-line';o.appendChild(l);
document.querySelector('#player').appendChild(o);state.overlay=o;state.line=l;
l.innerHTML='<div class="udth-en">This means that the value of X is checked for a strict equality to the value from the</div><div class="udth-th" lang="th">หมายความว่าระบบจะนำค่าของ X ไปตรวจความเท่ากันแบบเข้มงวด (strict equality) กับค่าใน ตัวแปรอีกตัวหนึ่งที่ส่งเข้ามา</div>';
placeOverlay();
</script>`
const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1040, height: 700 } })
for (const [h, bar] of [[560, 56], [330, 56], [330, 90]]) {
  await p.setContent(html(h, bar)); await p.waitForTimeout(400)
  const r = await p.evaluate(() => {
    const t = document.querySelector('.udth-th').getBoundingClientRect(), s = document.querySelector('#scrub').getBoundingClientRect(), pl = document.querySelector('#player').getBoundingClientRect(), e = document.querySelector('.udth-en').getBoundingClientRect()
    return { gapAboveScrubber: Math.round(s.top - t.bottom), thTop: Math.round(t.top - pl.top), enTop: Math.round(e.top - pl.top), bottomStyle: document.querySelector('.udth-overlay').style.bottom }
  })
  console.log('player', h, 'bar', bar, JSON.stringify(r))
  await p.screenshot({ path: `C:/Users/ADMINI~1/AppData/Local/Temp/ov_${h}_${bar}.png`, clip: { x: 0, y: 0, width: 1000, height: h } })
}
await b.close()
